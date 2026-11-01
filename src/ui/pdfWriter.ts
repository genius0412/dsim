/**
 * A SMALL PDF WRITER: text in the two standard Helvetica faces, rectangles, lines, and one JPEG.
 *
 * Hand-written for the reason `adminCharts.tsx` draws its own SVG: the client takes no
 * libraries (CLAUDE.md), and what the sponsor report needs is a page of text, tables and bar
 * charts, which is a few hundred lines rather than a dependency. The standard 14 fonts need no
 * embedding, so a page is a content stream of drawing operators and nothing else.
 *
 * Coordinates are in points from the TOP-LEFT, y down, like the canvas; the writer flips them.
 * Text is WinAnsi: typographic quotes, dashes, the bullet and the middle dot map to their
 * codes; anything else outside Latin-1 prints as `?`.
 *
 * DOM-free, so `npm test` builds a document headlessly and checks its structure.
 */

/** Helvetica advance widths for 32..126, in 1/1000 em (the standard AFM) */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** Helvetica-Bold, same range */
const HELV_B = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** the WinAnsi codes above 126 this writer uses, with [regular, bold] widths */
const HIGH: Record<string, [number, number, number]> = {
  '…': [0x85, 1000, 1000],
  '‘': [0x91, 222, 278],
  '’': [0x92, 222, 278],
  '“': [0x93, 333, 500],
  '”': [0x94, 333, 500],
  '•': [0x95, 350, 350],
  '–': [0x96, 556, 556],
  '—': [0x97, 1000, 1000],
  '™': [0x99, 1000, 1000],
  ' ': [0xa0, 278, 278],
  '©': [0xa9, 737, 737],
  '±': [0xb1, 584, 584],
  '·': [0xb7, 278, 278],
  '×': [0xd7, 584, 584],
  '−': [0x2d, 333, 333],
};

/** one character as its WinAnsi code and its width */
function glyph(ch: string, bold: boolean): [number, number] {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return [c, (bold ? HELV_B : HELV)[c - 32]];
  const hi = HIGH[ch];
  if (hi) return [hi[0], bold ? hi[2] : hi[1]];
  if (c >= 0xa0 && c <= 0xff) return [c, 556];
  return [63, bold ? 611 : 556]; // '?'
}

/** the width of `s` in points at `size` */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) w += glyph(ch, bold)[1];
  return (w * size) / 1000;
}

/** `s` as a PDF string literal's body: WinAnsi bytes, with `(`, `)` and `\` escaped */
function pdfString(s: string, bold: boolean): string {
  let out = '';
  for (const ch of s) {
    const code = glyph(ch, bold)[0];
    const c = String.fromCharCode(code);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

/** break `text` into lines no wider than `width` at `size`, on spaces */
export function wrapText(text: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, bold) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export type Rgb = [number, number, number];

/** `#1f9e89` → [r, g, b] in 0..1 */
export function hex(h: string): Rgb {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const num = (v: number): string => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb): string => c.map(num).join(' ');

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
}

export class PdfPage {
  /** the content stream, one operator per line */
  readonly ops: string[] = [];
  usesImage = false;

  constructor(readonly width: number, readonly height: number) {}

  private y(v: number): number {
    return this.height - v;
  }

  /** text whose BASELINE is at `y` */
  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    const size = o.size ?? 10;
    const bold = !!o.bold;
    const w = textWidth(s, size, bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(o.color ?? [0, 0, 0])} rg ${num(left)} ${num(this.y(y))} Td (${pdfString(s, bold)}) Tj ET`,
    );
  }

  /** wrapped text from a top baseline; returns the y below the last line */
  paragraph(x: number, y: number, width: number, s: string, o: TextOpts & { leading?: number } = {}): number {
    const size = o.size ?? 10;
    const lead = o.leading ?? size * 1.4;
    for (const line of wrapText(s, width, size, o.bold)) {
      this.text(x, y, line, o);
      y += lead;
    }
    return y;
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }): void {
    const parts: string[] = ['q'];
    if (o.fill) parts.push(`${rgb(o.fill)} rg`);
    if (o.stroke) parts.push(`${rgb(o.stroke)} RG ${num(o.lineWidth ?? 0.5)} w`);
    parts.push(`${num(x)} ${num(this.y(y + h))} ${num(w)} ${num(h)} re`);
    parts.push(o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S', 'Q');
    this.ops.push(parts.join(' '));
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { color?: Rgb; width?: number; dash?: number[] } = {}): void {
    this.polyline(
      [
        [x1, y1],
        [x2, y2],
      ],
      o,
    );
  }

  polyline(pts: [number, number][], o: { color?: Rgb; width?: number; dash?: number[] } = {}): void {
    if (pts.length < 2) return;
    const path = pts.map(([px, py], i) => `${num(px)} ${num(this.y(py))} ${i ? 'l' : 'm'}`).join(' ');
    const dash = o.dash ? `[${o.dash.map(num).join(' ')}] 0 d ` : '';
    this.ops.push(`q ${rgb(o.color ?? [0, 0, 0])} RG ${num(o.width ?? 1)} w 1 J 1 j ${dash}${path} S Q`);
  }

  /** the document's one image, drawn into the box */
  image(x: number, y: number, w: number, h: number): void {
    this.usesImage = true;
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y(y + h))} cm /Im1 Do Q`);
  }
}

export class PdfDoc {
  readonly pages: PdfPage[] = [];
  private jpeg: { bytes: Uint8Array; w: number; h: number } | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly info: { title: string; created: Date },
  ) {}

  addPage(): PdfPage {
    const p = new PdfPage(this.width, this.height);
    this.pages.push(p);
    return p;
  }

  /** a baseline JPEG, RGB, for `PdfPage.image` */
  setImage(bytes: Uint8Array, w: number, h: number): void {
    this.jpeg = { bytes, w, h };
  }

  hasImage(): boolean {
    return this.jpeg !== null;
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const offsets: number[] = [];
    const push = (b: Uint8Array): void => {
      chunks.push(b);
      length += b.length;
    };
    // every string written is Latin-1 by construction: one char, one byte
    const latin1 = (s: string): Uint8Array => {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
      return b;
    };
    const obj = (n: number, body: string): void => {
      offsets[n] = length;
      push(latin1(`${n} 0 obj\n${body}\nendobj\n`));
    };

    push(latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
    // 1 catalog, 2 pages, 3 4 fonts, 5 info, 6 image, then a page and its content per page
    const first = 7;
    const kids = this.pages.map((_, i) => `${first + i * 2} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const d = this.info.created;
    const p2 = (v: number): string => String(v).padStart(2, '0');
    const stamp = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    obj(5, `<< /Title (${pdfString(this.info.title, false)}) /Producer (DSIM) /CreationDate (${stamp}) >>`);
    if (this.jpeg) {
      offsets[6] = length;
      push(
        latin1(
          `6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${this.jpeg.w} /Height ${this.jpeg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.jpeg.bytes.length} >>\nstream\n`,
        ),
      );
      push(this.jpeg.bytes);
      push(latin1('\nendstream\nendobj\n'));
    } else {
      obj(6, 'null');
    }
    this.pages.forEach((page, i) => {
      const n = first + i * 2;
      const xobj = this.jpeg && page.usesImage ? ' /XObject << /Im1 6 0 R >>' : '';
      obj(
        n,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${n + 1} 0 R >>`,
      );
      const content = latin1(page.ops.join('\n'));
      offsets[n + 1] = length;
      push(latin1(`${n + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n`));
      push(content);
      push(latin1('\nendstream\nendobj\n'));
    });

    const size = first + this.pages.length * 2;
    const xref = length;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(latin1(`${table}trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
