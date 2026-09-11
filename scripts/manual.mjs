#!/usr/bin/env node
/**
 * manual.mjs — fetch an FTC game manual and turn it into something greppable.
 *
 *   node scripts/manual.mjs [url-or-manual-number] [outdir]
 *
 * Every season starts the same way: read the manual, then re-read the same six
 * paragraphs forty times while building the field. A PDF is the worst possible
 * shape for that, so this pulls it down once and leaves three artifacts next to
 * each other in `scratch/manual/`:
 *
 *   <name>.pdf            the original, kept so a re-run is free
 *   <name>.txt            `pdftotext -layout` — preserves the TABLES, which is
 *                         where the point values and the dimensions live
 *   <name>.glossary.txt   `pdftotext` with no layout flag — the glossary and any
 *                         other two-column page interleaves under `-layout`
 *                         ("PIXEL  A 5 in ..." becomes two half-lines side by
 *                         side), and reading order is what you want there
 *   figures/*.png         only when `pdfimages` is on PATH (poppler-utils full
 *                         install); the MSYS/mingw build ships pdftotext alone
 *
 * ...and prints the page count plus a table of where each "Section N" starts, so
 * the next thing you run is `sed -n '<start>,<end>p'` on a page range rather than
 * a blind grep over 150 pages.
 *
 * Node stdlib only, no deps: this is tooling that has to work on a fresh clone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** FIRST's stable shortlink for the CURRENT season's competition manual. */
const DEFAULT_URL = 'https://ftc-resources.firstinspires.org/ftc/game/manual';
const DEFAULT_OUTDIR = 'scratch/manual';

/**
 * A bare number is a manual PART: FIRST has historically published "Game Manual
 * Part 1" / "Part 2" as `<base>-1` / `<base>-2`, while a single-volume season
 * lives at the bare `manual` slug (BIOBUZZ V0 does). Anything containing `://`
 * is taken as a literal URL so an in-season revision or a mirror still works.
 */
function urlOf(arg) {
  if (!arg) return DEFAULT_URL;
  if (arg.includes('://')) return arg;
  if (/^\d+$/.test(arg)) return `${DEFAULT_URL}-${arg}`;
  // a bare slug: treat it as a path under the same resource host
  return `https://ftc-resources.firstinspires.org/ftc/game/${arg}`;
}

/** the downloaded file's name, preferring the server's own (it carries the
 * season name and the revision — `BIOBUZZ_Competition_Manual_V0.pdf`). */
function nameOf(res, url) {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const raw = star ? decodeURIComponent(star[1]) : plain ? plain[1] : basename(new URL(url).pathname);
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (safe || 'manual').replace(/\.pdf$/i, '');
}

function has(bin) {
  // `--version` on a missing binary throws ENOENT, which is the whole test
  const r = spawnSync(bin, ['-v'], { stdio: 'ignore' });
  return !r.error;
}

/** run a poppler tool, failing loudly — a silently empty .txt is worse than a stack trace */
function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw new Error(`${bin} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}`);
}

/**
 * SECTION INDEX. `pdftotext` separates pages with a form feed, so splitting on
 * \f gives an array whose index is the PHYSICAL page number − 1 — that is also
 * how the page COUNT is derived here, because the mingw poppler build has no
 * `pdfinfo`.
 *
 * The reliable signal is FIRST's own RUNNING FOOTER, which every page carries:
 *
 *     Section 4 Advancement        V0        28 of 93
 *
 * so the section name AND the manual's own printed page number are on one line.
 * Both are worth having: the printed number is what a rule citation means, and
 * the physical index is what `awk 'BEGIN{RS="\f"}'` wants — they differ by the
 * cover/TOC offset. A manual with no running footer falls back to matching a
 * bare heading line. Only the EARLIEST page for a given N is kept, since the
 * footer repeats on every page of the section.
 *
 * Body cross-references ("...described in Section 1.7.3 Team Updates") never
 * match: the footer form needs the trailing "N of M", and the heading form
 * needs the line to be nothing but the heading.
 */
function sectionIndex(pages) {
  /** @type {Map<number, { page: number; printed: number | null; title: string }>} */
  const found = new Map();
  const note = (n, page, printed, title) => {
    const prev = found.get(n);
    if (!prev || page < prev.page) found.set(n, { page, printed, title });
  };
  pages.forEach((page, i) => {
    for (const line of page.split('\n')) {
      const t = line.trimEnd();
      // FOOTER form. The lazy title expands until the tail ("<rev>  N of M")
      // lines up, so a title containing its own run of spaces survives.
      const f = /^\s*Section\s+(\d+)\s+(.+?)\s{2,}\S+\s+(\d+)\s+of\s+\d+\s*$/.exec(t);
      if (f) {
        note(Number(f[1]), i + 1, Number(f[3]), f[2].trim());
        continue;
      }
      // HEADING form: the whole line is the heading, nothing else on it.
      const h = /^\s*Section\s+(\d+)\s*[:.–-]?\s*([A-Z][^.]{0,58})$/.exec(t);
      if (h) note(Number(h[1]), i + 1, null, h[2].trim());
    }
  });
  return [...found.entries()].sort((a, b) => a[0] - b[0]);
}

async function main() {
  const [arg, outArg] = process.argv.slice(2);
  const url = urlOf(arg);
  const outdir = resolve(outArg || DEFAULT_OUTDIR);
  mkdirSync(outdir, { recursive: true });

  if (!has('pdftotext')) {
    console.error('pdftotext not on PATH. Install poppler-utils (git-bash ships it in mingw64/bin).');
    process.exit(2);
  }

  console.log(`GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    if (/^\d+$/.test(arg ?? '')) {
      console.error(`No part ${arg} this season? The single-volume manual is at ${DEFAULT_URL}.`);
    }
    process.exit(1);
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('pdf')) {
    console.error(`Not a PDF (content-type: ${ctype}) — ${res.url}`);
    process.exit(1);
  }

  const name = nameOf(res, url);
  const pdf = join(outdir, `${name}.pdf`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(pdf, buf);
  console.log(`  ${pdf}  ${(buf.length / 1024).toFixed(0)} KB`);

  // TABLES: `-layout` keeps column alignment, which is the only way the scoring
  // and dimension tables survive as anything readable.
  const txt = join(outdir, `${name}.txt`);
  run('pdftotext', ['-layout', pdf, txt]);
  console.log(`  ${txt}`);

  // GLOSSARY: the same PDF with layout OFF. A two-column page under `-layout`
  // puts the left and right columns on the same physical line, which shreds
  // every definition; reading order puts each entry back together.
  const gloss = join(outdir, `${name}.glossary.txt`);
  run('pdftotext', [pdf, gloss]);
  console.log(`  ${gloss}`);

  // FIGURES: the field drawings. `pdfimages` is a separate poppler binary and is
  // NOT in the mingw build, so this is best-effort by design rather than a
  // hard dependency — the text is the part the sim actually needs.
  if (has('pdfimages')) {
    const figs = join(outdir, 'figures');
    mkdirSync(figs, { recursive: true });
    run('pdfimages', ['-png', pdf, join(figs, name)]);
    console.log(`  ${figs}/  (pdfimages)`);
  } else {
    console.log('  figures skipped: pdfimages not on PATH (mingw poppler ships pdftotext only)');
  }

  const pages = readFileSync(txt, 'utf8').split('\f');
  // poppler emits a trailing \f after the last page, so a final empty chunk is
  // an artifact of the split and not a page
  if (pages.length && pages[pages.length - 1].trim() === '') pages.pop();
  console.log(`\n${name}: ${pages.length} pages`);

  const idx = sectionIndex(pages);
  if (!idx.length) {
    console.log('no "Section N" headings found — check the .txt by hand');
    return;
  }
  console.log('\n  pdf  printed  section');
  for (const [n, { page, printed, title }] of idx) {
    const p = printed === null ? '     ?' : String(printed).padStart(6);
    console.log(`  ${String(page).padStart(3)}  ${p}  Section ${n}${title ? ` — ${title}` : ''}`);
  }
  console.log(`\nawk 'BEGIN{RS="\\f"} NR>=<pdf> && NR<=<pdf>' "${txt}"   # "pdf" column = \\f page index`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
