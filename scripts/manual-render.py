#!/usr/bin/env python3
"""
manual-render.py — render manual PAGES to PNG, for the drawings the figure
extractor cannot reach.

    python scripts/manual-render.py [pdf] [--pages 60-75] [--dpi 300] [--outdir DIR]

`scripts/manual-figures.mjs` pulls embedded image XObjects, which is the right
tool for a photo or a rendered screenshot pasted into the manual. It finds
NOTHING for a drawing authored as vector paths — and FTC field drawings usually
are.  No flag makes those appear, because there is no image object to extract:
the page must be RASTERISED instead.

So this is the documented fallback from `docs/biobuzz-reference.md`, automated.
It renders whole pages at a known, stated DPI, which is what makes the result
measurable: at D dots per inch a PDF point (1/72 in) is exactly D/72 pixels, so
the page-space scale is known before a single pixel is counted, and the only
unknown left is the drawing's own scale — one stated dimension fixes that.

DELIBERATELY NOT NODE, AND DELIBERATELY OPTIONAL. Every other script in this
repo is Node stdlib so a fresh clone can run it; rasterising a PDF is the one
job with no stdlib answer, and shipping a vendored renderer to avoid a Python
dependency is a worse trade than an optional script that says so. Install with:

    pip install pymupdf

Output goes to `scratch/` (gitignored) like the rest of the manual intake: the
PDF and its pages are FIRST's, and what belongs in the repo is the MEASUREMENT
and the citation, not the source image.
"""
import argparse
import pathlib
import re
import sys

DEFAULT_PDF_GLOB = "scratch/manual/*.pdf"
DEFAULT_OUTDIR = "scratch/manual/pages"


def parse_pages(spec, n):
    """'60-75', '61', '60-75,92' → a sorted list of 1-based page numbers."""
    if not spec:
        return list(range(1, n + 1))
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if m:
            lo, hi = int(m[1]), int(m[2])
            if lo > hi:
                sys.exit(f"bad page range {part!r}: {lo} > {hi}")
            out.update(range(lo, hi + 1))
        elif part.isdigit():
            out.add(int(part))
        else:
            sys.exit(f"bad page spec {part!r} — want '60', '60-75' or a comma list")
    bad = [p for p in out if p < 1 or p > n]
    if bad:
        sys.exit(f"pages out of range for a {n}-page PDF: {sorted(bad)}")
    return sorted(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", nargs="?", help=f"default: newest match of {DEFAULT_PDF_GLOB}")
    ap.add_argument("--pages", help="'60-75' or '61' or '60-75,92'; default every page")
    ap.add_argument("--dpi", type=int, default=300,
                    help="render resolution; 300 is measurable, 600 for a dense callout")
    ap.add_argument("--outdir", default=DEFAULT_OUTDIR)
    args = ap.parse_args()

    try:
        import pymupdf as fitz  # PyMuPDF >= 1.24 ships this name; `fitz` is deprecated
    except ImportError:
        try:
            import fitz  # older PyMuPDF
        except ImportError:
            fitz = None
    if fitz is None:
        sys.exit("PyMuPDF is not installed — this script is the OPTIONAL page-rasteriser.\n"
                 "  pip install pymupdf\n"
                 "Everything else in the manual-intake pipeline is Node stdlib and needs nothing.")

    if args.pdf:
        pdf = pathlib.Path(args.pdf)
    else:
        found = sorted(pathlib.Path().glob(DEFAULT_PDF_GLOB), key=lambda p: p.stat().st_mtime)
        if not found:
            sys.exit(f"no PDF at {DEFAULT_PDF_GLOB} — run `node scripts/manual.mjs` first")
        pdf = found[-1]
    if not pdf.is_file():
        sys.exit(f"not a file: {pdf}")

    doc = fitz.open(pdf)
    pages = parse_pages(args.pages, doc.page_count)
    outdir = pathlib.Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # At D dpi a PDF point is D/72 px. State it: it is half of every measurement
    # made on these files, and it is not recoverable from the PNG afterwards.
    scale = args.dpi / 72.0
    mat = fitz.Matrix(scale, scale)

    print(f"{pdf.name}: {doc.page_count} pages, rendering {len(pages)} at {args.dpi} dpi "
          f"({scale:.4f} px per PDF point)")

    rows = []
    for n in pages:
        page = doc.load_page(n - 1)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        name = f"p{n:03d}-{args.dpi}dpi-{pix.width}x{pix.height}.png"
        pix.save(outdir / name)
        w_in = page.rect.width / 72.0
        rows.append((n, pix.width, pix.height, w_in, name))
        print(f"  p{n:>3}  {pix.width}x{pix.height}  {name}")

    index = outdir / "index.md"
    with index.open("w", encoding="utf-8") as f:
        f.write(f"# Rendered pages — {pdf.name}\n\n")
        f.write(f"{len(rows)} pages at **{args.dpi} dpi**. "
                f"One PDF point (1/72 in) is **{scale:.4f} px** here.\n\n")
        f.write("These are whole-page rasters, not extracted figures: this is the fallback for a\n"
                "field drawing authored as VECTOR PATHS, which `scripts/manual-figures.mjs`\n"
                "cannot extract because there is no image object to pull.\n\n")
        f.write("| page | pixels | page width (in) | file |\n|---:|---|---:|---|\n")
        for n, w, h, w_in, name in rows:
            f.write(f"| {n} | {w}×{h} | {w_in:.2f} | {name} |\n")
        f.write(
            "\n## Measuring one of these\n\n"
            "The page scale is known and stated above, so the only unknown is the DRAWING's own\n"
            "scale. Find ONE dimension the manual states in words or in a callout, measure it in\n"
            "pixels, and every other dimension on that drawing follows from the ratio. Check the\n"
            "result against a SECOND stated dimension before trusting it.\n\n"
            "Record the page, the reference dimension and the pixel counts in\n"
            "`docs/biobuzz-reference.md` — as `page N render @ "
            f"{args.dpi}dpi` in place of a figure filename, since the in/px ratio belongs to the\n"
            "render and not to the PDF.\n")
    print(f"  {index}")


if __name__ == "__main__":
    main()
