import type { ReactNode } from 'react';

/**
 * Tiny, self-contained Markdown renderer (no runtime deps, per the project rule).
 * Renders to REACT ELEMENTS — never `dangerouslySetInnerHTML` — so admin-authored
 * announcement bodies (patch notes / season / act) can use structure without any
 * HTML-injection surface.
 *
 * Supported subset (enough for long-form patch notes):
 *   # .. ###### headings   |   paragraphs (blank-line separated)
 *   - / * / • / + bullets, 1. / 1) ordered, nested by indent (2 spaces = 1 level)
 *   **bold** __bold__  |  *italic* _italic_  |  `inline code`
 *   [label](https://url)  |  --- / *** horizontal rule
 * Anything else renders as its literal text. Unknown/unsafe link schemes are dropped.
 */

const LIST_RE = /^(\s*)(?:([-*•+])|(\d+)[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;

/** allow only http(s), mailto, and same-origin relative links; everything else → '#' */
function safeHref(href: string): string {
  const h = href.trim();
  return /^(https?:\/\/|mailto:|\/)/i.test(h) ? h : '#';
}

/** inline spans: code, bold, italic, links. Recurses for nested emphasis. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  type Rule = { re: RegExp; el: (m: RegExpExecArray, k: string) => ReactNode };
  const rules: Rule[] = [
    { re: /`([^`]+)`/, el: (m, k) => <code key={k} className="md-code">{m[1]}</code> },
    { re: /\*\*([^*]+)\*\*/, el: (m, k) => <strong key={k}>{inline(m[1], k)}</strong> },
    { re: /__([^_]+)__/, el: (m, k) => <strong key={k}>{inline(m[1], k)}</strong> },
    { re: /(?<![*\w])\*([^*\n]+)\*(?![*\w])/, el: (m, k) => <em key={k}>{inline(m[1], k)}</em> },
    { re: /(?<![_\w])_([^_\n]+)_(?![_\w])/, el: (m, k) => <em key={k}>{inline(m[1], k)}</em> },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/,
      el: (m, k) => (
        <a key={k} className="md-link" href={safeHref(m[2])} target="_blank" rel="noopener noreferrer">
          {m[1]}
        </a>
      ),
    },
  ];
  while (rest.length > 0) {
    let best: { i: number; m: RegExpExecArray; r: Rule } | null = null;
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (m && (best === null || m.index < best.i)) best = { i: m.index, m, r };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.i > 0) out.push(rest.slice(0, best.i));
    out.push(best.r.el(best.m, `${key}i${n++}`));
    rest = rest.slice(best.i + best.m[0].length);
  }
  return out;
}

interface Item {
  ordered: boolean;
  text: string;
  children: Item[];
}

/** build a nested item tree from a run of list lines, using indentation for depth */
function listTree(block: string[]): Item[] {
  const roots: Item[] = [];
  const stack: { indent: number; item: Item }[] = [];
  for (const raw of block) {
    const m = LIST_RE.exec(raw);
    if (!m) {
      // an indented wrap line continues the current item's text
      if (stack.length) stack[stack.length - 1].item.text += ' ' + raw.trim();
      continue;
    }
    const indent = m[1].length;
    const item: Item = { ordered: m[3] !== undefined, text: m[4].trim(), children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(item);
    else stack[stack.length - 1].item.children.push(item);
    stack.push({ indent, item });
  }
  return roots;
}

/** render a tree, grouping consecutive same-type siblings into one <ul>/<ol> */
function renderItems(items: Item[], keyOf: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const ordered = items[i].ordered;
    const group: Item[] = [];
    while (i < items.length && items[i].ordered === ordered) group.push(items[i++]);
    out.push(
      ordered ? (
        <ol key={keyOf()} className="md-list md-ol">
          {group.map((it) => {
            const k = keyOf();
            return (
              <li key={k} className="md-li">
                {inline(it.text, k)}
                {it.children.length > 0 && renderItems(it.children, keyOf)}
              </li>
            );
          })}
        </ol>
      ) : (
        <ul key={keyOf()} className="md-list md-ul">
          {group.map((it) => {
            const k = keyOf();
            return (
              <li key={k} className="md-li">
                {inline(it.text, k)}
                {it.children.length > 0 && renderItems(it.children, keyOf)}
              </li>
            );
          })}
        </ul>
      ),
    );
  }
  return out;
}

function heading(level: number, content: ReactNode, key: string): ReactNode {
  const cls = `md-h md-h${Math.min(level, 4)}`;
  if (level <= 1) return <h3 key={key} className={cls}>{content}</h3>;
  if (level === 2) return <h4 key={key} className={cls}>{content}</h4>;
  return <h5 key={key} className={cls}>{content}</h5>;
}

/** Render a Markdown string as themed React elements. */
export function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let k = 0;
  const keyOf = (): string => `b${k++}`;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push(<hr key={keyOf()} className="md-hr" />);
      i++;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const key = keyOf();
      blocks.push(heading(h[1].length, inline(h[2].trim(), key), key));
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const block: string[] = [];
      // collect list lines plus their indented continuation lines
      while (i < lines.length && lines[i].trim() !== '' && (LIST_RE.test(lines[i]) || /^\s+\S/.test(lines[i]))) {
        block.push(lines[i]);
        i++;
      }
      renderItems(listTree(block), keyOf).forEach((el) => blocks.push(el));
      continue;
    }
    // paragraph: gather consecutive plain lines
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    const key = keyOf();
    blocks.push(<p key={key} className="md-p">{inline(para.join(' '), key)}</p>);
  }
  return <div className={className ? `md ${className}` : 'md'}>{blocks}</div>;
}
