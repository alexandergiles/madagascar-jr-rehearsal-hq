"""
OCR the Madagascar Jr. script (v2: uses 4 split PDFs in ../Madagascar script/).

Merges all four PDFs into a single script.pdf, OCRs each page with Apple
Vision, and writes:
  - media/script.pdf   — concatenated PDF (unencrypted; encrypt_media.py encrypts)
  - script_text.json   — {"pages": [{"page": N, "text": "..."}, ...]}
  - characters.json    — deduplicated list of speaking characters detected

Safe to re-run — reuses cached OCR from script_text.json if present.
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
SOURCE_DIR = ROOT.parent / "Madagascar script "  # trailing space in real name
SOURCE_PDFS = ["1-28.pdf", "29-62.pdf", "63-94.pdf", "95-end.pdf"]
MERGED_PDF = ROOT / "media" / "script.pdf"
TEXT_JSON = ROOT / "script_text.json"
CHARS_JSON = ROOT / "characters.json"

CUE_RE = re.compile(r"^([A-Z][A-Z0-9 &/'.\-]{1,28}[A-Z.])[\.\:]\s*(.*)$")

STOP_WORDS = {
    "ACT", "SCENE", "END", "END OF ACT", "END OF SCENE", "END OF PLAY",
    "PROLOGUE", "EPILOGUE", "INTERMISSION", "CURTAIN", "BLACKOUT",
    "SFX", "SOUND", "SOUND EFFECT", "LIGHTS", "MUSIC", "NOTE", "NOTES",
    "SONG", "REPRISE", "STAGE DIRECTION",
    "ALL", "ALL LEMURS", "ALL PENGUINS",
    "MADAGASCAR", "JR", "MADAGASCAR JR", "MADAGASCAR JR.",
    "ADVENTURE JR", "ADVENTURE JR.", "A MUSICAL ADVENTURE JR",
    "MTI", "MUSIC THEATRE INTERNATIONAL",
    "THE END",
}


def merge_pdfs():
    if not SOURCE_DIR.exists():
        print(f"[ocr] source not found: {SOURCE_DIR}", file=sys.stderr)
        sys.exit(1)
    merged = fitz.open()
    for name in SOURCE_PDFS:
        p = SOURCE_DIR / name
        if not p.exists():
            print(f"[ocr] missing: {p}", file=sys.stderr)
            sys.exit(1)
        src = fitz.open(str(p))
        merged.insert_pdf(src)
        print(f"[ocr] merged {name}: {src.page_count} pages")
        src.close()
    MERGED_PDF.parent.mkdir(exist_ok=True)
    merged.save(str(MERGED_PDF))
    print(f"[ocr] wrote merged PDF: {MERGED_PDF} ({merged.page_count} pages)")
    return merged


def load_existing():
    if TEXT_JSON.exists():
        try:
            return json.loads(TEXT_JSON.read_text())
        except Exception:
            return {"pages": []}
    return {"pages": []}


def save_pages(pages):
    TEXT_JSON.write_text(json.dumps({"pages": pages}, indent=2))


def ocr_page(pdf, page_idx, tmp_dir, dpi=300):
    page = pdf[page_idx]
    zoom = dpi / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    p = tmp_dir / f"p{page_idx+1:03d}.png"
    pix.save(str(p))
    results = ocrmac.OCR(str(p), recognition_level="accurate").recognize()
    return [r[0] for r in results]


def extract_characters(pages):
    tally = Counter()
    for pg in pages:
        for line in pg.get("text", "").splitlines():
            line = line.strip()
            m = CUE_RE.match(line)
            if not m:
                continue
            cue = re.sub(r"\s+", " ", m.group(1).strip().strip(".").strip())
            if len(cue) < 3 or len(cue) > 30:
                continue
            if cue in STOP_WORDS:
                continue
            if any(w in cue for w in ("SCENE", "PROLOGUE", "EPILOGUE", "INTERMISSION")):
                continue
            tally[cue] += 1
    return [(name, n) for name, n in tally.most_common() if n >= 2]


def main():
    merged = merge_pdfs()
    total = merged.page_count

    existing = load_existing()
    done = {p["page"] for p in existing["pages"]}
    pages = list(existing["pages"])
    # If existing OCR is from the old PDF (different length), invalidate.
    if pages and max(p["page"] for p in pages) != total:
        print(f"[ocr] cached OCR is stale (was {max(p['page'] for p in pages)} pages, now {total}); rebuilding")
        done = set()
        pages = []

    with tempfile.TemporaryDirectory() as td:
        tmp_dir = Path(td)
        for i in range(total):
            page_num = i + 1
            if page_num in done:
                continue
            try:
                lines = ocr_page(merged, i, tmp_dir)
            except Exception as e:
                print(f"[ocr] page {page_num}: ERROR {e}")
                pages.append({"page": page_num, "text": ""})
                continue
            pages.append({"page": page_num, "text": "\n".join(lines)})
            if page_num % 5 == 0 or page_num == total:
                pages.sort(key=lambda p: p["page"])
                save_pages(pages)
                print(f"[ocr] page {page_num}/{total} done ({len(lines)} lines)")

    pages.sort(key=lambda p: p["page"])
    save_pages(pages)
    print(f"[ocr] wrote {TEXT_JSON}")

    chars = extract_characters(pages)
    CHARS_JSON.write_text(
        json.dumps(
            {"characters": [{"name": name, "lines": n} for name, n in chars]},
            indent=2,
        )
    )
    print(f"[ocr] wrote {CHARS_JSON}  ({len(chars)} characters)")
    for name, n in chars[:20]:
        print(f"   {name:30s}  {n} cues")


if __name__ == "__main__":
    main()
