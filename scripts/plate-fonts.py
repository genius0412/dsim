"""
PLATE FONTS: subset the robot-sign typefaces and measure them (`src/plateFonts.ts`, `src/plateLayout.ts`).

    python -m venv .venv && .venv/bin/pip install fonttools brotli
    python scripts/plate-fonts.py <dir of source .ttf files>

Writes `src/assets/plateFonts/<key>.woff2` and prints the `PLATE_FONT_METRICS` table to paste
into `src/plateLayout.ts`. Re-run it whenever a face or the glyph set changes: the table is what
the sign lays the number out by, so it must come from the same file the browser loads.

Sources, all SIL Open Font License 1.1, from the Google Fonts repository (`ofl/<dir>/<file>`):
    standard  barlowsemicondensed/BarlowSemiCondensed-ExtraBold.ttf
    block     archivoblack/ArchivoBlack-Regular.ttf
    racing    saira/Saira[wdth,wght].ttf            instanced at wdth 100, wght 800
    angular   chakrapetch/ChakraPetch-Bold.ttf
    mono      jetbrainsmono/JetBrainsMono[wght].ttf instanced at wght 800
None declares a Reserved Font Name, so a subset may keep its name (OFL 1.1 section 3). The
licence travels in each file's name table (IDs 0, 13 and 14) and in `OFL.txt` beside them.

The subset is the eleven glyphs a sign can print (`bbRobotSignText`: digits, or `-` for no team
number), no hinting and no layout features. With no `kern` feature the browser's advance for a
string is the sum of the table's advances, which is what the layout assumes.
"""
import json
import os
import sys

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

TEXT = '0123456789-'
FACES = [
    ('standard', 'BarlowSemiCondensed-ExtraBold.ttf', None),
    ('block', 'ArchivoBlack-Regular.ttf', None),
    ('racing', 'Saira[wdth,wght].ttf', {'wdth': 100, 'wght': 800}),
    ('angular', 'ChakraPetch-Bold.ttf', None),
    ('mono', 'JetBrainsMono[wght].ttf', {'wght': 800}),
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'plateFonts')


def main(src: str) -> None:
    os.makedirs(OUT, exist_ok=True)
    table = {}
    for key, fn, loc in FACES:
        font = TTFont(os.path.join(src, fn))
        if loc is not None:
            font = instancer.instantiateVariableFont(font, loc)
        opts = subset.Options()
        opts.flavor = 'woff2'
        opts.hinting = False
        opts.desubroutinize = True
        opts.layout_features = []
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
        opts.notdef_outline = False
        sub = subset.Subsetter(opts)
        sub.populate(text=TEXT)
        sub.subset(font)
        subset.save_font(font, os.path.join(OUT, f'{key}.woff2'), opts)
        upm = font['head'].unitsPerEm
        cmap = font.getBestCmap()
        glyphs = font.getGlyphSet()
        rows = {}
        for ch in TEXT:
            name = cmap[ord(ch)]
            pen = BoundsPen(glyphs)
            glyphs[name].draw(pen)
            x0, y0, x1, y1 = pen.bounds
            rows[ch] = [round(v / upm, 4) for v in (font['hmtx'][name][0], x0, x1, y0, y1)]
        table[key] = {'cap': round(font['OS/2'].sCapHeight / upm, 4), 'glyphs': rows}
    print(json.dumps(table, indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
