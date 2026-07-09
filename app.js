/* ============================================
   Madagascar Jr. Rehearsal HQ — App logic
   ============================================ */

const STORAGE_KEY = "madagascar_prep_v1";
const CHAR_STORAGE_KEY = "madagascar_character_v1";
const KEY_STORAGE_KEY = "madagascar_key_v1"; // cached derived AES key (b64)
const SCRIPT_PATH = "media/script.pdf.enc";
const AUDIO_PATH_PREFIX = "media/";
const AUDIO_PATH_SUFFIX = ".enc";
const SCRIPT_TEXT_PATH = "script_text.json.enc";
const LYRICS_PATH = "lyrics.json.enc";
const VERIFIER_PATH = "verifier.enc";
const CRYPTO_META_PATH = "crypto_meta.json";
// The merged PDF has 5 pages of front matter before script page 1.
// So printed page N == PDF page N + 5.
const SCRIPT_PAGE_OFFSET = 5;
const pdfToScript = (p) => p - SCRIPT_PAGE_OFFSET;
const scriptToPdf = (s) => s + SCRIPT_PAGE_OFFSET;

let TRACKS = [];
let GROUPS = {}; // {"1": {start, end, label}, ...}
let progress = loadProgress();
let currentFilter = "ensemble";
let currentGroup = "all"; // "all" | "1" | "2" | "3"
let currentAudio = null;
let currentCharacter = loadCharacter();
let SCRIPT_TEXT = null; // {pages: [{page, text}]} — loaded from OCR when ready
let CHARACTERS = null; // {characters: [{name, lines}]} — loaded when OCR ready
let LYRICS = null; // {"1": [{speaker, text}], ...} — loaded lazily

// ---------- storage ----------
function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}
function loadCharacter() {
  return localStorage.getItem(CHAR_STORAGE_KEY) || "ENSEMBLE";
}
function saveCharacter(c) {
  localStorage.setItem(CHAR_STORAGE_KEY, c);
}

// ---------- crypto ----------
let CRYPTO_KEY = null;
let CRYPTO_META = null;

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)));

async function deriveKey(passkey, saltB64, iters) {
  const salt = b64ToBytes(saltB64);
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passkey),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can cache it
    ["decrypt", "encrypt"]
  );
}

async function decryptBuffer(buf, key = CRYPTO_KEY) {
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
}

async function fetchAndDecrypt(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return decryptBuffer(buf);
}

async function encryptBuffer(plaintext, key = CRYPTO_KEY) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

// ---------- GitHub Contents API (editor mode) ----------
const GH_OWNER = "alexandergiles";
const GH_REPO = "madagascar-jr-rehearsal-hq";
const GH_BRANCH = "main";
const PAT_STORAGE_KEY = "madagascar_gh_pat_v1";
const EDITOR_MODE_KEY = "madagascar_editor_mode_v1";

function getPAT() {
  return localStorage.getItem(PAT_STORAGE_KEY) || "";
}
function setPAT(v) {
  if (v) localStorage.setItem(PAT_STORAGE_KEY, v);
  else localStorage.removeItem(PAT_STORAGE_KEY);
}
function isEditorMode() {
  return !!getPAT() && localStorage.getItem(EDITOR_MODE_KEY) === "1";
}
function setEditorMode(on) {
  localStorage.setItem(EDITOR_MODE_KEY, on ? "1" : "0");
}

async function ghGetFile(path) {
  const pat = getPAT();
  if (!pat) throw new Error("no PAT");
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json(); // { sha, content (b64), ... }
}

async function ghPutFile(path, bytes, sha, message) {
  const pat = getPAT();
  if (!pat) throw new Error("no PAT");
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: bytesToB64(bytes),
      sha,
      branch: GH_BRANCH,
    }),
  });
  if (res.status === 409 || res.status === 422) {
    const err = new Error("conflict");
    err.conflict = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PUT ${path}: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function saveEncryptedJSON(path, obj, message) {
  // Fetch latest sha (so we detect conflicts with concurrent edits)
  const info = await ghGetFile(path);
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBytes = await encryptBuffer(plain);
  return ghPutFile(path, cipherBytes, info.sha, message);
}

async function tryVerifyKey(key) {
  try {
    const res = await fetch(VERIFIER_PATH, { cache: "no-cache" });
    if (!res.ok) return false;
    const plain = await decryptBuffer(await res.arrayBuffer(), key);
    return new TextDecoder().decode(plain) === CRYPTO_META.verifier_plaintext;
  } catch {
    return false;
  }
}

async function loadCryptoMeta() {
  const res = await fetch(CRYPTO_META_PATH, { cache: "no-cache" });
  CRYPTO_META = await res.json();
}

async function importCachedKey() {
  const cached = localStorage.getItem(KEY_STORAGE_KEY);
  if (!cached) return null;
  try {
    const raw = b64ToBytes(cached);
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: 256 },
      true,
      ["decrypt", "encrypt"]
    );
  } catch {
    return null;
  }
}

async function cacheKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  localStorage.setItem(KEY_STORAGE_KEY, bytesToB64(raw));
}

async function ensureUnlocked() {
  await loadCryptoMeta();
  const cached = await importCachedKey();
  if (cached && (await tryVerifyKey(cached))) {
    CRYPTO_KEY = cached;
    return;
  }
  localStorage.removeItem(KEY_STORAGE_KEY);
  await showLockScreen();
}

function showLockScreen() {
  const lock = document.getElementById("lock-screen");
  const form = document.getElementById("lock-form");
  const input = document.getElementById("lock-input");
  const submit = document.getElementById("lock-submit");
  const err = document.getElementById("lock-error");
  lock.hidden = false;
  setTimeout(() => input.focus(), 50);

  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.hidden = true;
      try {
        const k = await deriveKey(
          input.value,
          CRYPTO_META.salt_b64,
          CRYPTO_META.iters
        );
        if (await tryVerifyKey(k)) {
          CRYPTO_KEY = k;
          await cacheKey(k);
          lock.hidden = true;
          resolve();
          return;
        }
        err.hidden = false;
        input.select();
      } finally {
        submit.disabled = false;
      }
    });
  });
}

// ---------- boot ----------
async function boot() {
  await ensureUnlocked();

  const res = await fetch("songs.json");
  const data = await res.json();
  TRACKS = data.tracks;
  GROUPS = data.groups || {};

  // Try to load OCR results — may not exist yet
  await maybeLoadOcrData();

  populateCharacterDropdown();
  wireCharacterDropdown();
  wireTabs();
  wireFilters();
  wireGroupFilters();
  wireResetBtn();
  wireGroupJumpButtons();
  wireEditorToggle();
  renderCounts();
  renderSongs();
  renderProgress();
  initScriptViewer();

  // Try loading OCR data now; if it isn't there yet, poll every 10s.
  maybeLoadOcrData().then(() => {
    if (CHARACTERS) populateCharacterDropdown();
    if (SCRIPT_TEXT && pdfState.doc) updateLinesPanel(pdfState.pageNum);
    if (LYRICS) renderSongs();
    if (!SCRIPT_TEXT || !CHARACTERS || !LYRICS) pollForOcrData();
  });
}

async function maybeLoadOcrData() {
  try {
    if (!SCRIPT_TEXT) {
      const plain = await fetchAndDecrypt(SCRIPT_TEXT_PATH);
      SCRIPT_TEXT = JSON.parse(new TextDecoder().decode(plain));
    }
  } catch {
    // decrypt/fetch failed — leave null, poller will retry
  }
  try {
    if (!LYRICS) {
      const plain = await fetchAndDecrypt(LYRICS_PATH);
      LYRICS = JSON.parse(new TextDecoder().decode(plain));
    }
  } catch {
    // ignore — lyrics may not be encrypted yet
  }
  try {
    if (!CHARACTERS) {
      const res = await fetch("characters.json", { cache: "no-cache" });
      if (res.ok) {
        CHARACTERS = await res.json();
        _canonicalSet = null;
      }
    }
  } catch {
    // ignore
  }
}

function pollForOcrData() {
  if (SCRIPT_TEXT && CHARACTERS && LYRICS) return;
  const iv = setInterval(async () => {
    await maybeLoadOcrData();
    if (CHARACTERS) {
      populateCharacterDropdown();
    }
    if (SCRIPT_TEXT && pdfState.doc) {
      updateLinesPanel(pdfState.pageNum);
    }
    if (LYRICS) {
      renderSongs();
    }
    if (SCRIPT_TEXT && CHARACTERS && LYRICS) {
      clearInterval(iv);
    }
  }, 10000);
}

// ---------- character dropdown ----------
function populateCharacterDropdown() {
  const sel = document.getElementById("character-select");
  const prev = sel.value || currentCharacter;

  // Union: hardcoded principals + anything OCR found (limited to speaking roles)
  const canonical = [
    "ENSEMBLE",
    "ALEX",
    "MARTY",
    "GLORIA",
    "MELMAN",
    "SKIPPER",
    "KOWALSKI",
    "RICO",
    "PRIVATE",
    "KING JULIEN",
    "MAURICE",
    "MORT",
    "FOOSA",
  ];

  const fromOcr = CHARACTERS?.characters?.map((c) => c.name) || [];
  const all = Array.from(new Set([...canonical, ...fromOcr]));

  sel.innerHTML = "";
  all.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent =
      name === "ENSEMBLE" ? "Ensemble (default)" : prettyName(name);
    sel.appendChild(opt);
  });

  sel.value = all.includes(prev) ? prev : "ENSEMBLE";
  currentCharacter = sel.value;
}

function wireCharacterDropdown() {
  const sel = document.getElementById("character-select");
  sel.addEventListener("change", () => {
    currentCharacter = sel.value;
    saveCharacter(currentCharacter);
    renderSongs();
    renderCounts();
    renderProgress();
    if (pdfState.doc) updateLinesPanel(pdfState.pageNum);
  });
}

// ---------- tabs ----------
function activateTab(tabId) {
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document
    .querySelectorAll(".tab-panel")
    .forEach((p) => p.classList.toggle("active", p.id === tabId));
  if (tabId !== "songs" && currentAudio) currentAudio.pause();
  if (tabId === "script") renderPage(pdfState.pageNum);
  if (tabId === "progress") renderProgress();
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      activateTab(tabId);
      history.replaceState(null, "", `#${tabId}`);
    });
  });
  const initial = (location.hash || "").replace("#", "");
  if (["songs", "script", "progress"].includes(initial)) activateTab(initial);
}

// ---------- filters ----------
function wireFilters() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentFilter = btn.dataset.filter;
      document
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      renderSongs();
      renderCounts();
    });
  });
}

function wireGroupFilters() {
  document.querySelectorAll(".group-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentGroup = btn.dataset.group;
      document
        .querySelectorAll(".group-filter-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      renderSongs();
      renderCounts();
    });
  });
}

function songsForCategory(cat) {
  return cat === "all" ? TRACKS : TRACKS.filter((t) => t.category === cat);
}

function tracksForGroup(tracks) {
  if (currentGroup === "all") return tracks;
  const g = parseInt(currentGroup, 10);
  return tracks.filter((t) => t.group === g);
}

function tracksForCharacter(tracks) {
  if (!currentCharacter || currentCharacter === "ENSEMBLE") return tracks;
  return tracks.filter(
    (t) => Array.isArray(t.characters) && t.characters.includes(currentCharacter)
  );
}

function renderCounts() {
  // Category counts respect current group + character filters
  ["ensemble", "listen", "underscore", "all"].forEach((cat) => {
    const filtered = tracksForGroup(tracksForCharacter(songsForCategory(cat)));
    document
      .querySelectorAll(`[data-count="${cat}"]`)
      .forEach((el) => (el.textContent = filtered.length));
  });
  // Group counts respect current category + character filters
  [1, 2, 3].forEach((gid) => {
    const base = tracksForCharacter(songsForCategory(currentFilter));
    const count = base.filter((t) => t.group === gid).length;
    document
      .querySelectorAll(`[data-groupcount="${gid}"]`)
      .forEach((el) => (el.textContent = count));
  });
}

// ---------- render songs ----------
function lyricsBlocksToText(blocks) {
  // "SPEAKER: line\nSPEAKER: line" — blank speaker becomes "(chorus): line"
  return blocks
    .map((b) => `${b.speaker || "-"}: ${b.text}`)
    .join("\n");
}
function lyricsTextToBlocks(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:]{1,40}):\s*(.*)$/);
    if (m) {
      const spk = m[1].trim();
      out.push({
        speaker: spk === "-" ? "" : spk.toUpperCase(),
        text: m[2].trim(),
      });
    } else {
      // continuation of the previous block
      if (out.length) out[out.length - 1].text += " " + line;
      else out.push({ speaker: "", text: line });
    }
  }
  return out;
}

function renderLyricsBlock(track) {
  if (!LYRICS) {
    return `<details class="lyrics-block">
      <summary>📜 Lyrics</summary>
      <p class="lyrics-loading">Lyrics loading… come back in a sec.</p>
    </details>`;
  }
  const blocks = LYRICS[String(track.num)] || [];
  const editing = isEditorMode();
  if (!blocks.length && !editing) return "";
  const body = blocks
    .map((b) => {
      const spk = b.speaker
        ? `<span class="lyric-speaker">${escapeHtml(prettyName(b.speaker))}</span>`
        : "";
      return `<div class="lyric-block">${spk}<span class="lyric-text">${escapeHtml(
        b.text
      )}</span></div>`;
    })
    .join("");
  const editUI = editing
    ? `<div class="lyrics-editor" data-song="${track.num}">
        <textarea class="lyrics-textarea" rows="10" spellcheck="false"
          placeholder="SPEAKER: line one&#10;SPEAKER: line two">${escapeHtml(
            lyricsBlocksToText(blocks)
          )}</textarea>
        <div class="editor-row">
          <button class="save-btn" data-role="save-lyrics" data-song="${track.num}">💾 Save for everyone</button>
          <span class="editor-hint">Format: <code>SPEAKER: text</code>, one per line.</span>
          <span class="editor-status" data-role="status"></span>
        </div>
      </div>`
    : "";
  return `<details class="lyrics-block">
    <summary>📜 Lyrics${editing ? " (editing)" : ""}</summary>
    <div class="lyrics-body">${body || '<p class="lyrics-empty">No lyrics yet — add some below.</p>'}</div>
    ${editUI}
    ${editing ? "" : '<p class="lyrics-note">Auto-extracted from the vocal score — a little OCR noise is expected.</p>'}
  </details>`;
}

function renderSongs() {
  const list = document.getElementById("song-list");
  list.innerHTML = "";

  let filtered = songsForCategory(currentFilter);
  filtered = tracksForCharacter(filtered);
  filtered = tracksForGroup(filtered);

  if (filtered.length === 0) {
    list.innerHTML = `<p class="hint">No songs in this filter for
      <b>${escapeHtml(currentCharacter)}</b>. Try a different filter or
      character.</p>`;
    return;
  }

  filtered.forEach((track) => {
    const card = document.createElement("div");
    const status = progress[track.num]?.status || "";
    card.className = `song-card ${status}`;
    card.dataset.num = track.num;

    const groupStartId = Object.entries(GROUPS).find(
      ([, g]) => g.firstSong === track.num
    )?.[0];
    const groupBadge = groupStartId
      ? `<span class="group-start-badge group-${groupStartId}">★ First piece in Group ${groupStartId}</span>`
      : "";

    card.innerHTML = `
      <div class="song-header">
        <div class="song-titleblock">
          <span class="song-num">#${String(track.num).padStart(2, "0")}</span>
          <span class="song-title">${escapeHtml(track.title)}</span>
          ${groupBadge}
          <div class="song-who">${escapeHtml(track.who)}</div>
          <div class="song-scene">${escapeHtml(track.scene)}</div>
        </div>
        <div class="status-picker">
          <button class="status-btn ${
            status === "learning" ? "selected" : ""
          }" data-status="learning" title="I'm just learning this">🌱 Learning</button>
          <button class="status-btn ${
            status === "working" ? "selected" : ""
          }" data-status="working" title="Working on it">💪 Working</button>
          <button class="status-btn ${
            status === "solid" ? "selected" : ""
          }" data-status="solid" title="I've got it!">⭐ Solid</button>
        </div>
      </div>
      <div class="player-row">
        <button class="play-btn" title="Play/pause">▶</button>
        <audio preload="none" data-file="${escapeHtml(
          track.file
        )}" controls></audio>
        <div class="speed-block">
          <span>Speed</span>
          <input type="range" class="speed-slider" min="0.5" max="1.25" step="0.05" value="1" />
          <span class="speed-label">1.00×</span>
        </div>
      </div>
      ${renderLyricsBlock(track)}
    `;

    card.querySelectorAll(".status-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const st = btn.dataset.status;
        const existing = progress[track.num]?.status;
        if (existing === st) delete progress[track.num];
        else progress[track.num] = { status: st, updated: Date.now() };
        saveProgress();
        renderSongs();
      });
    });

    const audio = card.querySelector("audio");
    const playBtn = card.querySelector(".play-btn");
    const speedSlider = card.querySelector(".speed-slider");
    const speedLabel = card.querySelector(".speed-label");

    playBtn.addEventListener("click", async () => {
      if (audio.paused) {
        if (currentAudio && currentAudio !== audio) currentAudio.pause();
        if (!audio.src) {
          playBtn.classList.add("loading");
          try {
            const encName =
              AUDIO_PATH_PREFIX + encodeURI(track.file) + AUDIO_PATH_SUFFIX;
            const plain = await fetchAndDecrypt(encName);
            const blob = new Blob([plain], { type: "audio/mpeg" });
            audio.src = URL.createObjectURL(blob);
          } catch (err) {
            playBtn.classList.remove("loading");
            alert("Couldn't decrypt this track. Try refreshing.");
            return;
          }
          playBtn.classList.remove("loading");
        }
        audio.play();
      } else {
        audio.pause();
      }
    });
    audio.addEventListener("play", () => {
      currentAudio = audio;
      playBtn.textContent = "⏸";
      playBtn.classList.add("playing");
    });
    audio.addEventListener("pause", () => {
      playBtn.textContent = "▶";
      playBtn.classList.remove("playing");
    });
    audio.addEventListener("ended", () => {
      playBtn.textContent = "▶";
      playBtn.classList.remove("playing");
    });
    speedSlider.addEventListener("input", () => {
      const v = parseFloat(speedSlider.value);
      audio.playbackRate = v;
      speedLabel.textContent = v.toFixed(2) + "×";
    });

    const saveBtn = card.querySelector('[data-role="save-lyrics"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const editor = card.querySelector(".lyrics-editor");
        const ta = editor.querySelector("textarea");
        const status = editor.querySelector('[data-role="status"]');
        const newBlocks = lyricsTextToBlocks(ta.value);
        saveBtn.disabled = true;
        status.textContent = "Saving…";
        status.className = "editor-status saving";
        try {
          const next = { ...(LYRICS || {}) };
          if (newBlocks.length) next[String(track.num)] = newBlocks;
          else delete next[String(track.num)];
          await saveEncryptedJSON(
            "lyrics.json.enc",
            next,
            `edit lyrics: #${track.num} ${track.title}`
          );
          LYRICS = next;
          status.textContent = "Saved! Others will see it after Pages rebuilds (~40s).";
          status.className = "editor-status ok";
          renderSongs();
        } catch (err) {
          if (err.conflict) {
            status.textContent =
              "Conflict — someone else edited. Refresh and try again.";
          } else {
            status.textContent = "Error: " + err.message;
          }
          status.className = "editor-status err";
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    list.appendChild(card);
  });
}

// ---------- progress tab ----------
function renderProgress() {
  const scope = tracksForCharacter(TRACKS);
  const label =
    currentCharacter === "ENSEMBLE"
      ? "Showing progress for <b>Ensemble</b> — all songs you'd be on stage for."
      : `Showing progress for <b>${prettyName(
          currentCharacter
        )}</b> — only songs this character appears in.`;
  document.getElementById("progress-scope").innerHTML = label;

  const buckets = { solid: 0, working: 0, learning: 0, untouched: 0 };
  scope.forEach((t) => {
    const s = progress[t.num]?.status;
    if (s === "solid") buckets.solid++;
    else if (s === "working") buckets.working++;
    else if (s === "learning") buckets.learning++;
    else buckets.untouched++;
  });
  document.getElementById("stat-solid").textContent = buckets.solid;
  document.getElementById("stat-working").textContent = buckets.working;
  document.getElementById("stat-learning").textContent = buckets.learning;
  document.getElementById("stat-untouched").textContent = buckets.untouched;

  fillProgressList(
    "progress-ensemble",
    tracksForCharacter(TRACKS.filter((t) => t.category === "ensemble"))
  );
  fillProgressList(
    "progress-listen",
    tracksForCharacter(TRACKS.filter((t) => t.category === "listen"))
  );
}

function fillProgressList(id, tracks) {
  const wrap = document.getElementById(id);
  wrap.innerHTML = "";
  if (tracks.length === 0) {
    wrap.innerHTML =
      '<p class="lines-empty">No songs in this category for the selected character.</p>';
    return;
  }
  tracks.forEach((t) => {
    const s = progress[t.num]?.status;
    const badge =
      s === "solid" ? "⭐" : s === "working" ? "💪" : s === "learning" ? "🌱" : "💤";
    const div = document.createElement("div");
    div.className = "progress-item";
    div.innerHTML = `
      <span>#${String(t.num).padStart(2, "0")} ${escapeHtml(t.title)}</span>
      <span class="badge">${badge}</span>
    `;
    wrap.appendChild(div);
  });
}

function wireResetBtn() {
  document.getElementById("reset-progress").addEventListener("click", () => {
    if (
      confirm(
        "Really reset all your song progress? You'll lose your Solid / Working / Learning marks."
      )
    ) {
      progress = {};
      saveProgress();
      renderSongs();
      renderProgress();
    }
  });
}

// ---------- group jump buttons ----------
function wireGroupJumpButtons() {
  document.querySelectorAll(".group-jump-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = GROUPS[btn.dataset.group];
      if (!g) return;
      renderPage(scriptToPdf(g.start));
    });
  });
}

// ---------- editor mode ----------
function updateEditorToggleUI() {
  const btn = document.getElementById("editor-toggle");
  const label = document.getElementById("editor-toggle-label");
  const on = isEditorMode();
  label.textContent = on ? "Editor: ON" : "Editor: off";
  btn.classList.toggle("on", on);
  document.body.classList.toggle("editor-on", on);
}

function wireEditorToggle() {
  updateEditorToggleUI();
  const btn = document.getElementById("editor-toggle");
  const modal = document.getElementById("pat-modal");
  const form = document.getElementById("pat-form");
  const input = document.getElementById("pat-input");
  const status = document.getElementById("pat-status");
  const cancel = document.getElementById("pat-cancel");
  const clearBtn = document.getElementById("pat-clear");

  const openModal = () => {
    input.value = getPAT();
    status.textContent = "";
    modal.hidden = false;
    setTimeout(() => input.focus(), 50);
  };
  const closeModal = () => {
    modal.hidden = true;
  };

  btn.addEventListener("click", () => {
    if (isEditorMode()) {
      // Turn off editor mode; keep PAT stored (they can flip back on quickly)
      setEditorMode(false);
      updateEditorToggleUI();
      renderSongs();
      if (pdfState.doc) updateLinesPanel(pdfState.pageNum);
    } else {
      openModal();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) {
      status.textContent = "Paste a token first.";
      return;
    }
    setPAT(v);
    setEditorMode(true);
    updateEditorToggleUI();
    closeModal();
    renderSongs();
    if (pdfState.doc) updateLinesPanel(pdfState.pageNum);
  });

  clearBtn.addEventListener("click", () => {
    setPAT("");
    setEditorMode(false);
    updateEditorToggleUI();
    status.textContent = "Token forgotten.";
    input.value = "";
    renderSongs();
    if (pdfState.doc) updateLinesPanel(pdfState.pageNum);
  });

  cancel.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
}

// ---------- group banner ----------
function groupForPage(page) {
  for (const [id, g] of Object.entries(GROUPS)) {
    if (page >= g.start && page <= g.end) return { id, ...g };
  }
  return null;
}

function updateGroupBanner(page) {
  const banner = document.getElementById("group-banner");
  const g = groupForPage(page);
  if (!g) {
    banner.classList.remove("show");
    return;
  }
  banner.className = `group-banner show group-${g.id}`;
  const emoji = g.id === "3" ? "🌟" : g.id === "2" ? "🎬" : "🎭";
  const note =
    g.id === "3"
      ? `You're in Group 3! (pages ${g.start}–${g.end})`
      : `Group ${g.id} · pages ${g.start}–${g.end}`;
  const primary =
    g.id === "3"
      ? "YOU'RE ON — GROUP 3"
      : `Group ${g.id} — ${g.label.replace(/^Group \d+\s*[·(-]?\s*/i, "")}`;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.7rem;">
      <span class="big-emoji">${emoji}</span>
      <div>
        <div>${escapeHtml(primary)}</div>
        <div class="group-note">${escapeHtml(note)}</div>
      </div>
    </div>
    <div style="font-size:0.85rem;font-weight:700;opacity:0.85;">
      Page ${page}
    </div>
  `;
}

// ---------- lines panel ----------
const CUE_RE = /^([A-Z][A-Z0-9 &/'.\-]{1,28}[A-Z.])[\.\:]\s*(.*)$/;
const HARDCODED_CANONICAL = [
  "ALEX", "MARTY", "GLORIA", "MELMAN",
  "SKIPPER", "KOWALSKI", "RICO", "PRIVATE", "PENGUINS",
  "KING JULIEN", "MAURICE", "MORT", "LEMURS", "LEMUR SOLOISTS",
  "FOOSA", "LIONESSES", "ANIMALS",
  "ZOOKEEPER ZELDA", "ZOOKEEPER ZEKE", "ZOOKEEPER ZOE",
  "ZOO GUESTS", "GUESTS", "ALL SERVERS", "LARS",
  "ALL", "ALL LEMURS", "ALL PENGUINS",
];
const RUNHEAD_RE = /^(MADAGASCAR( JR\.?)?|A MUSICAL ADVENTURE( JR\.?)?)$/i;
let _canonicalSet = null;
function canonicalSet() {
  if (_canonicalSet) return _canonicalSet;
  const s = new Set(HARDCODED_CANONICAL);
  (CHARACTERS?.characters || []).forEach((c) => s.add(c.name.toUpperCase()));
  _canonicalSet = s;
  return s;
}
function stripParentheticals(s) {
  // remove (stage directions) — non-nested is fine for OCR text
  return s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeCueName(raw) {
  return raw.replace(/[.:,]+$/, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function extractCuesFromPageText(text) {
  const cues = [];
  const lines = text.split("\n");
  const canon = canonicalSet();
  let current = null;
  const flush = () => {
    if (!current) return;
    current.text = stripParentheticals(current.text);
    if (current.name || current.text) cues.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (RUNHEAD_RE.test(line)) continue;
    // Skip pure page numbers / footer noise
    if (/^\d{1,3}\.?$/.test(line)) continue;
    // Skip lines that are entirely a parenthetical stage direction
    if (/^\([^)]*\)?$/.test(line)) continue;

    // 1) NAME: dialogue on one line
    const m = line.match(CUE_RE);
    if (m) {
      const name = normalizeCueName(m[1]);
      if (canon.has(name) || /^[A-Z][A-Z .&'/-]+$/.test(name)) {
        flush();
        current = { name, text: m[2] || "" };
        continue;
      }
    }

    // 2) Bare canonical name on its own line — dialogue follows on next lines
    const bare = normalizeCueName(line);
    if (canon.has(bare)) {
      flush();
      current = { name: bare, text: "" };
      continue;
    }

    // 3) Continuation of current cue's dialogue
    if (current) {
      current.text += (current.text ? " " : "") + line;
    }
  }
  flush();
  return cues;
}

function updateLinesPanel(page) {
  const content = document.getElementById("lines-content");
  const title = document.getElementById("lines-panel-title");

  if (!SCRIPT_TEXT) {
    title.textContent = "Your lines on this page";
    content.innerHTML =
      '<p class="lines-loading">Reading the script… OCR is still running in the background. Come back in a minute — your lines will show up here automatically!</p>';
    return;
  }

  const pageEntry = SCRIPT_TEXT.pages.find((p) => p.page === page);
  const rawText = pageEntry?.text || "";
  const editing = isEditorMode();

  if (!pageEntry || !rawText) {
    title.textContent = `Page ${pdfToScript(page)}`;
    content.innerHTML = `
      <p class="lines-empty">No text detected on this page (might be a title or blank page).</p>
      ${editing ? renderScriptEditor(page, "") : ""}
    `;
    wireScriptEditor(page);
    return;
  }

  const cues = extractCuesFromPageText(rawText);
  const isEnsemble = currentCharacter === "ENSEMBLE";
  const mine = isEnsemble
    ? cues
    : cues.filter((c) => characterMatches(c.name, currentCharacter));

  title.textContent = isEnsemble
    ? `Scene lines on page ${pdfToScript(page)}`
    : `${prettyName(currentCharacter)}'s lines on page ${pdfToScript(page)}`;

  const cuesHtml =
    mine.length === 0
      ? `<p class="lines-empty">${prettyName(
          currentCharacter
        )} has no lines on page ${pdfToScript(page)}. Flip to the next page ▶</p>`
      : mine
          .map((c) => {
            const isMe =
              !isEnsemble && characterMatches(c.name, currentCharacter);
            return `
              <div class="line-block ${isMe ? "mine" : ""}">
                <span class="cue">${escapeHtml(c.name)}</span>
                ${escapeHtml(c.text) || '<i style="opacity:0.6;">(action)</i>'}
              </div>
            `;
          })
          .join("");

  content.innerHTML = `${cuesHtml}${
    editing ? renderScriptEditor(page, rawText) : ""
  }`;
  wireScriptEditor(page);
}

function renderScriptEditor(pdfPage, rawText) {
  return `
    <div class="script-editor" data-page="${pdfPage}">
      <h4>✏️ Edit OCR text for this page</h4>
      <p class="editor-hint">
        Fix the raw OCR — cues will re-parse automatically. Format:
        <code>SPEAKER: line</code>. This saves for everyone.
      </p>
      <textarea class="script-textarea" rows="16" spellcheck="false">${escapeHtml(
        rawText
      )}</textarea>
      <div class="editor-row">
        <button class="save-btn" data-role="save-script" data-page="${pdfPage}">
          💾 Save page ${pdfToScript(pdfPage)}
        </button>
        <span class="editor-status" data-role="status"></span>
      </div>
    </div>
  `;
}

function wireScriptEditor(pdfPage) {
  const btn = document.querySelector('[data-role="save-script"]');
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const editor = btn.closest(".script-editor");
    const ta = editor.querySelector("textarea");
    const status = editor.querySelector('[data-role="status"]');
    btn.disabled = true;
    status.textContent = "Saving…";
    status.className = "editor-status saving";
    try {
      const next = {
        pages: SCRIPT_TEXT.pages.map((p) =>
          p.page === pdfPage ? { ...p, text: ta.value } : p
        ),
      };
      // If page didn't exist yet, add it
      if (!next.pages.some((p) => p.page === pdfPage)) {
        next.pages.push({ page: pdfPage, text: ta.value });
        next.pages.sort((a, b) => a.page - b.page);
      }
      await saveEncryptedJSON(
        "script_text.json.enc",
        next,
        `edit script page ${pdfToScript(pdfPage)} (pdf p${pdfPage})`
      );
      SCRIPT_TEXT = next;
      status.textContent = "Saved! Others will see it after Pages rebuilds (~40s).";
      status.className = "editor-status ok";
      updateLinesPanel(pdfPage);
    } catch (err) {
      if (err.conflict) {
        status.textContent =
          "Conflict — someone else edited. Refresh and try again.";
      } else {
        status.textContent = "Error: " + err.message;
      }
      status.className = "editor-status err";
    } finally {
      btn.disabled = false;
    }
  });
}

function characterMatches(cueName, character) {
  if (!cueName || !character) return false;
  const nn = cueName.toUpperCase().replace(/\./g, "").trim();
  const cc = character.toUpperCase().trim();
  if (nn === cc) return true;
  // "ALEX & MARTY" contains "ALEX"
  const parts = nn.split(/[&/,]/).map((s) => s.trim());
  return parts.includes(cc);
}

function prettyName(name) {
  if (!name) return "";
  if (name === "ENSEMBLE") return "Ensemble";
  return name
    .split(" ")
    .map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// ---------- script viewer (PDF.js) ----------
const pdfState = {
  doc: null,
  pageNum: 1,
  scale: 1.2,
  rendering: false,
  pending: null,
};

async function initScriptViewer() {
  const canvas = document.getElementById("pdf-canvas");
  if (!window.pdfjsLib) {
    canvas.parentElement.innerHTML =
      '<p style="padding:2rem;text-align:center;color:#c33;font-weight:700;">PDF viewer failed to load. Are you online? PDF.js is loaded from a CDN.</p>';
    return;
  }
  try {
    const pdfBuf = await fetchAndDecrypt(SCRIPT_PATH);
    pdfState.doc = await pdfjsLib.getDocument({ data: pdfBuf }).promise;
  } catch (e) {
    canvas.parentElement.innerHTML = `<p style="padding:2rem;text-align:center;color:#c33;font-weight:700;">Could not load the script PDF.<br>Expected at: <code>${SCRIPT_PATH}</code><br>${escapeHtml(
      e.message || String(e)
    )}</p>`;
    return;
  }
  const totalScriptPages = pdfState.doc.numPages - SCRIPT_PAGE_OFFSET;
  document.getElementById("page-count").textContent = totalScriptPages;
  const pageInput = document.getElementById("page-input");
  pageInput.min = 1;
  pageInput.max = totalScriptPages;
  renderPage(scriptToPdf(1));

  document.getElementById("prev-page").addEventListener("click", () => {
    if (pdfState.pageNum > scriptToPdf(1)) renderPage(pdfState.pageNum - 1);
  });
  document.getElementById("next-page").addEventListener("click", () => {
    if (pdfState.pageNum < pdfState.doc.numPages)
      renderPage(pdfState.pageNum + 1);
  });
  pageInput.addEventListener("change", (e) => {
    const s = parseInt(e.target.value, 10);
    const p = scriptToPdf(s);
    if (p >= scriptToPdf(1) && p <= pdfState.doc.numPages) renderPage(p);
  });
  document.getElementById("zoom-in").addEventListener("click", () => {
    pdfState.scale = Math.min(3, pdfState.scale + 0.2);
    updateZoomLabel();
    renderPage(pdfState.pageNum);
  });
  document.getElementById("zoom-out").addEventListener("click", () => {
    pdfState.scale = Math.max(0.5, pdfState.scale - 0.2);
    updateZoomLabel();
    renderPage(pdfState.pageNum);
  });

  document.addEventListener("keydown", (e) => {
    const scriptActive = document
      .getElementById("script")
      .classList.contains("active");
    if (!scriptActive) return;
    if (
      document.activeElement &&
      document.activeElement.tagName === "INPUT"
    )
      return;
    if (e.key === "ArrowLeft" && pdfState.pageNum > scriptToPdf(1))
      renderPage(pdfState.pageNum - 1);
    if (e.key === "ArrowRight" && pdfState.pageNum < pdfState.doc.numPages)
      renderPage(pdfState.pageNum + 1);
  });

  updateZoomLabel();
}

function updateZoomLabel() {
  document.getElementById("zoom-label").textContent =
    Math.round((pdfState.scale * 100) / 1.2) + "%";
}

async function renderPage(n) {
  if (!pdfState.doc) return;
  if (pdfState.rendering) {
    pdfState.pending = n;
    return;
  }
  pdfState.rendering = true;
  pdfState.pageNum = n;
  document.getElementById("page-input").value = pdfToScript(n);
  updateGroupBanner(pdfToScript(n));
  updateLinesPanel(n);

  const page = await pdfState.doc.getPage(n);
  const canvas = document.getElementById("pdf-canvas");
  const ctx = canvas.getContext("2d");
  const viewport = page.getViewport({ scale: pdfState.scale });
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: ctx, viewport }).promise;
  pdfState.rendering = false;
  if (pdfState.pending !== null) {
    const p = pdfState.pending;
    pdfState.pending = null;
    renderPage(p);
  }
}

// ---------- utils ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

boot();
