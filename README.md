# Madagascar Jr. — Rehearsal HQ

A local site to help learn songs and read the script.

## Start it

```bash
cd "/Users/alexgiles/Documents/Projects/madagascar/prep"
python3 -m http.server 8080
```

Then open **http://localhost:8080** in a browser.

Stop the server with `Ctrl+C`.

## What's in it

- **🎵 Songs** — all 29 guide-vocal tracks with playback + speed control.
  Default filter is "My Numbers" (ensemble songs).
- **📖 Script** — full 116-page PDF, paged and zoomable.
- **🏆 Progress** — mark songs 🌱 Learning / 💪 Working / ⭐ Solid.
  Saved in the browser's localStorage (no account needed).

## Notes

- The PDF viewer uses PDF.js from a CDN, so you need internet the first time
  you load the page (it should cache after).
- Audio files stay in the parent `madagascar/` folder — the site just links
  to them, nothing is duplicated.
- All progress is per-browser. Use the same browser each time.
