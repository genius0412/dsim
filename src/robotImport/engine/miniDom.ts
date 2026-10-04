/**
 * A SMALL XML DOM for the import worker, which has no `DOMParser`: just enough of one for three's
 * `ThreeMFLoader` to run unchanged off the main thread. That loader is the only user, and what it
 * calls is the whole surface: `parseFromString`, `documentElement`, `nodeName`, `localName`,
 * `attributes` (name and value), `children`, `textContent`, `getAttribute`, `getAttributeNS`,
 * `getElementsByTagNameNS`, and `querySelector(All)` with type selectors joined by the descendant
 * combinator (`'vertices vertex'`).
 *
 * It follows XML 1.0 where the loader can see it: line ends normalised to LF, attribute values
 * whitespace-normalised and entity-decoded, character references, CDATA, comments and processing
 * instructions skipped, namespaces resolved from `xmlns` declarations in scope, and type selectors
 * matched on the LOCAL name in any namespace (CSS in an XML document with no default namespace).
 * Malformed XML throws, which the loader turns into the importer's "looks damaged" error.
 */

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface MiniAttr {
  name: string;
  localName: string;
  prefix: string | null;
  namespaceURI: string | null;
  value: string;
}

abstract class MiniParent {
  childNodes: (MiniElement | MiniText)[] = [];
  children: MiniElement[] = [];

  get textContent(): string {
    let s = '';
    const walk = (n: MiniElement | MiniText): void => {
      if (n instanceof MiniText) s += n.data;
      else for (const c of n.childNodes) walk(c);
    };
    for (const c of this.childNodes) walk(c);
    return s;
  }

  /** every element under this one, in document order */
  protected descendants(visit: (e: MiniElement) => boolean | void): void {
    const stack: MiniElement[] = [];
    for (let i = this.children.length - 1; i >= 0; i--) stack.push(this.children[i]);
    while (stack.length) {
      const e = stack.pop()!;
      if (visit(e) === true) return;
      for (let i = e.children.length - 1; i >= 0; i--) stack.push(e.children[i]);
    }
  }

  querySelectorAll(selector: string): MiniElement[] {
    const parts = parseSelector(selector);
    const out: MiniElement[] = [];
    this.descendants((e) => {
      if (matches(e, parts)) out.push(e);
    });
    return out;
  }

  querySelector(selector: string): MiniElement | null {
    const parts = parseSelector(selector);
    let hit: MiniElement | null = null;
    this.descendants((e) => {
      if (matches(e, parts)) {
        hit = e;
        return true;
      }
    });
    return hit;
  }

  getElementsByTagName(name: string): MiniElement[] {
    const out: MiniElement[] = [];
    this.descendants((e) => {
      if (name === '*' || e.nodeName === name) out.push(e);
    });
    return out;
  }

  getElementsByTagNameNS(ns: string | null, localName: string): MiniElement[] {
    const out: MiniElement[] = [];
    this.descendants((e) => {
      if ((ns === '*' || e.namespaceURI === ns) && (localName === '*' || e.localName === localName)) out.push(e);
    });
    return out;
  }
}

export class MiniText {
  readonly nodeType = 3;
  readonly nodeName = '#text';
  constructor(readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

export class MiniElement extends MiniParent {
  readonly nodeType = 1;
  parentNode: MiniElement | MiniDocument | null = null;
  constructor(
    readonly nodeName: string,
    readonly localName: string,
    readonly prefix: string | null,
    readonly namespaceURI: string | null,
    readonly attributes: MiniAttr[],
  ) {
    super();
  }
  get tagName(): string {
    return this.nodeName;
  }
  getAttribute(name: string): string | null {
    for (const a of this.attributes) if (a.name === name) return a.value;
    return null;
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }
  getAttributeNS(ns: string | null, localName: string): string | null {
    for (const a of this.attributes) if (a.namespaceURI === (ns || null) && a.localName === localName) return a.value;
    return null;
  }
}

export class MiniDocument extends MiniParent {
  readonly nodeType = 9;
  readonly nodeName = '#document';
  get documentElement(): MiniElement {
    return this.children[0];
  }
}

// ---- selectors: type selectors and the descendant combinator ---------------------------------

function parseSelector(selector: string): string[] {
  const parts = selector.trim().split(/\s+/);
  for (const p of parts) if (!/^([A-Za-z_][\w.-]*|\*)$/.test(p)) throw new Error(`selector not supported here: ${selector}`);
  return parts;
}

function matches(e: MiniElement, parts: string[]): boolean {
  const last = parts[parts.length - 1];
  if (last !== '*' && e.localName !== last) return false;
  let k = parts.length - 2;
  let a = e.parentNode;
  while (k >= 0 && a instanceof MiniElement) {
    if (parts[k] === '*' || a.localName === parts[k]) k--;
    a = a.parentNode;
  }
  return k < 0;
}

// ---- the parser --------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);/g, (_m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const v = ENTITIES[ref];
    if (v === undefined) throw new Error(`undefined entity &${ref};`);
    return v;
  });
}

const isNameChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 46 || c === 58 || c > 127;
const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

export class MiniDOMParser {
  parseFromString(input: string, _type?: string): MiniDocument {
    const text = input.indexOf('\r') >= 0 ? input.replace(/\r\n?/g, '\n') : input;
    const doc = new MiniDocument();
    const len = text.length;
    let i = 0;
    let cur: MiniDocument | MiniElement = doc;
    // namespace scopes: prefix → uri, one map per open element ('' is the default namespace)
    const scopes: Map<string, string>[] = [new Map([['xml', XML_NS]])];
    const lookup = (prefix: string): string | null => {
      for (let k = scopes.length - 1; k >= 0; k--) {
        const v = scopes[k].get(prefix);
        if (v !== undefined) return v || null;
      }
      return null;
    };
    const fail = (why: string): never => {
      throw new Error(`XML: ${why} at ${i}`);
    };
    const pushText = (s: string): void => {
      if (cur === doc) {
        if (s.trim()) fail('text outside the root element');
        return;
      }
      if (s) cur.childNodes.push(new MiniText(s));
    };
    while (i < len) {
      const lt = text.indexOf('<', i);
      if (lt < 0) {
        pushText(decode(text.slice(i)));
        break;
      }
      if (lt > i) pushText(decode(text.slice(i, lt)));
      i = lt;
      if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i + 4);
        if (e < 0) fail('unclosed comment');
        i = e + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const e = text.indexOf(']]>', i + 9);
        if (e < 0) fail('unclosed CDATA');
        pushText(text.slice(i + 9, e));
        i = e + 3;
        continue;
      }
      if (text.startsWith('<?', i)) {
        const e = text.indexOf('?>', i + 2);
        if (e < 0) fail('unclosed processing instruction');
        i = e + 2;
        continue;
      }
      if (text.startsWith('<!', i)) {
        // a DOCTYPE (no internal subset is honoured; 3MF has none)
        const e = text.indexOf('>', i + 2);
        if (e < 0) fail('unclosed declaration');
        i = e + 1;
        continue;
      }
      if (text.charCodeAt(i + 1) === 47) {
        // </name>
        let j = i + 2;
        while (j < len && isNameChar(text.charCodeAt(j))) j++;
        const name = text.slice(i + 2, j);
        while (j < len && isWs(text.charCodeAt(j))) j++;
        if (text.charCodeAt(j) !== 62) fail('bad end tag');
        if (!(cur instanceof MiniElement) || cur.nodeName !== name) fail(`mismatched </${name}>`);
        cur = (cur as MiniElement).parentNode!;
        scopes.pop();
        i = j + 1;
        continue;
      }
      // <name attr="v" …> or />
      let j = i + 1;
      while (j < len && isNameChar(text.charCodeAt(j))) j++;
      const qname = text.slice(i + 1, j);
      if (!qname) fail('empty tag name');
      const raw: [string, string][] = [];
      let selfClose = false;
      for (;;) {
        while (j < len && isWs(text.charCodeAt(j))) j++;
        if (j >= len) fail('unclosed tag');
        const c = text.charCodeAt(j);
        if (c === 62) {
          j++;
          break;
        }
        if (c === 47 && text.charCodeAt(j + 1) === 62) {
          selfClose = true;
          j += 2;
          break;
        }
        const a0 = j;
        while (j < len && isNameChar(text.charCodeAt(j))) j++;
        const an = text.slice(a0, j);
        if (!an) fail('bad attribute');
        while (j < len && isWs(text.charCodeAt(j))) j++;
        if (text.charCodeAt(j) !== 61) fail('attribute without a value');
        j++;
        while (j < len && isWs(text.charCodeAt(j))) j++;
        const q = text.charCodeAt(j);
        if (q !== 34 && q !== 39) fail('unquoted attribute');
        const e = text.indexOf(q === 34 ? '"' : "'", j + 1);
        if (e < 0) fail('unclosed attribute');
        // attribute-value normalisation: literal tab and newline become spaces, references stay
        raw.push([an, decode(text.slice(j + 1, e).replace(/[\t\n]/g, ' '))]);
        j = e + 1;
      }
      const scope = new Map<string, string>();
      for (const [n, v] of raw) {
        if (n === 'xmlns') scope.set('', v);
        else if (n.startsWith('xmlns:')) scope.set(n.slice(6), v);
      }
      scopes.push(scope);
      const split = (n: string): [string | null, string] => {
        const k = n.indexOf(':');
        return k < 0 ? [null, n] : [n.slice(0, k), n.slice(k + 1)];
      };
      const [prefix, localName] = split(qname);
      const ns = lookup(prefix ?? '');
      if (prefix && ns === null) fail(`unbound prefix ${prefix}`);
      const attrs: MiniAttr[] = raw.map(([n, v]) => {
        const [ap, al] = split(n);
        const ans = n === 'xmlns' || ap === 'xmlns' ? XMLNS_NS : ap ? lookup(ap) : null;
        return { name: n, localName: al, prefix: ap, namespaceURI: ans, value: v };
      });
      const el = new MiniElement(qname, localName, prefix, ns, attrs);
      el.parentNode = cur;
      cur.childNodes.push(el);
      cur.children.push(el);
      if (cur === doc && doc.children.length > 1) fail('two root elements');
      if (selfClose) scopes.pop();
      else cur = el;
      i = j;
    }
    if (cur !== doc) fail('unclosed element');
    if (!doc.children.length) fail('no root element');
    return doc;
  }
}

/** give a worker (which has none) this `DOMParser`; the page's own is left alone */
export function ensureDomParser(): void {
  const g = globalThis as unknown as { DOMParser?: unknown };
  if (typeof g.DOMParser === 'undefined') g.DOMParser = MiniDOMParser;
}
