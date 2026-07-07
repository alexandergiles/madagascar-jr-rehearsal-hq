"""
OCR the Madagascar Jr. script using Apple Vision (via ocrmac).

Renders each PDF page to a temp PNG, runs Vision OCR, writes:
  - script_text.json  — {"pages": [{"page": 1, "text": "..."}, ...]}
  - characters.json   — deduplicated list of speaking characters detected

Progress is streamed to stdout; safe to re-run — skips pages already done if
script_text.json exists and has that page.
"""

import json
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path

import fitz  # PyMuPDF
from ocrmac import ocrmac

ROOT = Path(__file__).parent
PDF_PATH = ROOT / "media" / "script.pdf"
TEXT_JSON = ROOT / "script_text.json"
CHARS_JSON = ROOT / "characters.json"

# Regex: character cue lines look like ALEX. or ALEX: or ALEX & MARTY. at start
# of a line. Allow ampersand, slash, dot, and single quote. 2-30 chars.
CUE_RE = re.compile(r"^([A-Z][A-Z0-9 &/'.\-]{1,28}[A-Z.])[\.\:]\s*(.*)$")

# Non-character shouty tokens to exclude from the character dropdown
STOP_WORDS = {
    "ACT", "SCENE", "END", "END OF ACT", "END OF SCENE", "END OF PLAY",
    "PROLOGUE", "EPILOGUE", "INTERMISSION", "CURTAIN", "BLACKOUT",
    "SFX", "SOUND", "SOUND EFFECT", "LIGHTS", "MUSIC", "NOTE", "NOTES",
    "SONG", "REPRISE", "STAGE DIRECTION",
    # common all-caps stage directions
    "ALL", "ALL LEMURS", "ALL PENGUINS",
    # metadata / boilerplate
    "MADAGASCAR", "JR", "MADAGASCAR JR", "MADAGASCAR JR.",
    "MTI", "MUSIC THEATRE INTERNATIONAL",
    "THE END",
}


def load_existing():
    if TEXT_JSON.exists():
        try:
            return json.loads(TEXT_JSON.read_text())
        except Exception:
            return {"pages": []}
    return {"pages": []}


def save_pages(pages):
    TEXT_JSON.write_text(json.dumps({"pages": pages}, indent=2))


def render_page_to_png(pdf, page_idx, tmp_dir, dpi=250):
    page = pdf[page_idx]
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    p = tmp_dir / f"p{page_idx+1:03d}.png"
    pix.save(str(p))
    return p


def extract_characters(pages):
    """Return list of (character, count) sorted by count desc."""
    tally = Counter()
    for pg in pages:
        text = pg.get("text", "")
        for line in text.splitlines():
            line = line.strip()
            m = CUE_RE.match(line)
            if not m:
                continue
            cue = m.group(1).strip().strip(".").strip()
            # normalize spacing
            cue = re.sub(r"\s+", " ", cue).strip()
            if len(cue) < 2 or len(cue) > 30:
                continue
            if cue in STOP_WORDS:
                continue
            # skip single-letter tokens except common ones
            if len(cue) < 3:
                continue
            # skip lines that look like scene headers (contain "SCENE" etc.)
            if any(w in cue for w in ("SCENE", "PROLOGUE", "EPILOGUE", "INTERMISSION")):
                continue
            tally[cue] += 1
    # keep only characters that speak at least twice — filters OCR noise
    return [(name, n) for name, n in tally.most_common() if n >= 2]


def main():
    pdf = fitz.open(str(PDF_PATH))
    total = pdf.page_count
    print(f"[ocr] script has {total} pages")

    existing = load_existing()
    done = {p["page"] for p in existing["pages"]}
    pages = list(existing["pages"])

    with tempfile.TemporaryDirectory() as td:
        tmp_dir = Path(td)
        for i in range(total):
            page_num = i + 1
            if page_num in done:
                continue
            png = render_page_to_png(pdf, i, tmp_dir)
            try:
                results = ocrmac.OCR(
                    str(png), recognition_level="accurate"
                ).recognize()
            except Exception as e:
                print(f"[ocr] page {page_num}: ERROR {e}")
                pages.append({"page": page_num, "text": ""})
                continue
            # results: list of (text, confidence, bbox)
            lines = [r[0] for r in results]
            pages.append({"page": page_num, "text": "\n".join(lines)})
            if page_num % 5 == 0 or page_num == total:
                print(f"[ocr] page {page_num}/{total} done ({len(lines)} lines)")
                save_pages(pages)

    save_pages(pages)
    print(f"[ocr] wrote {TEXT_JSON}")

    chars = extract_characters(pages)
    CHARS_JSON.write_text(
        json.dumps(
            {
                "characters": [
                    {"name": name, "lines": n} for name, n in chars
                ]
            },
            indent=2,
        )
    )
    print(f"[ocr] wrote {CHARS_JSON}  ({len(chars)} characters)")
    for name, n in chars[:30]:
        print(f"   {name:30s}  {n} cues")


if __name__ == "__main__":
    main()
