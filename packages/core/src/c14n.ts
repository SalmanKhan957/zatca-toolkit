import { NS, type XElement, type XNode } from './dom.js';

/**
 * Inclusive XML Canonicalization without comments (C14N 1.0 / 1.1).
 *
 * For documents like UBL invoices (no DTD, no xml:id / xml:base attributes) the
 * outputs of C14N 1.0 and 1.1 are identical, which is what ZATCA's hashing relies on.
 *
 * Rules implemented (W3C xml-c14n11, section 2):
 *  - no XML declaration or DTD; comments dropped
 *  - empty elements written as start/end tag pairs
 *  - namespace declarations rendered only when they differ from the nearest
 *    output ancestor's in-scope namespaces; default namespace first, then by prefix
 *  - attributes sorted by namespace URI, then local name
 *  - text escapes: & < > and CR; attribute escapes: & < " TAB LF CR
 *
 * `exclude` drops matching elements *and their subtrees* while keeping the
 * surrounding whitespace text nodes, matching XPath-filter transform semantics.
 */
export interface C14nOptions {
  exclude?: (el: XElement) => boolean;
}

export function canonicalize(node: XNode, options: C14nOptions = {}): string {
  const out: string[] = [];
  const exclude = options.exclude ?? (() => false);

  if (node.nodeType === 9) {
    // Document node: render the root element only (no prolog, comments dropped).
    const root = (node as Document).documentElement as XElement | null;
    if (root && !exclude(root)) renderElement(root, inheritedNamespaces(root), new Map(), out, exclude);
    return out.join('');
  }
  if (node.nodeType === 1) {
    const el = node as XElement;
    if (!exclude(el)) renderElement(el, inheritedNamespaces(el), new Map(), out, exclude);
    return out.join('');
  }
  throw new Error('canonicalize() expects a document or element node');
}

/** In-scope namespaces declared on the ancestors of `el` (not on `el` itself). */
function inheritedNamespaces(el: XElement): Map<string, string> {
  const chain: XElement[] = [];
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) chain.unshift(p as XElement);
  const scope = new Map<string, string>();
  for (const anc of chain) applyDeclarations(anc, scope);
  return scope;
}

function applyDeclarations(el: XElement, scope: Map<string, string>): void {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)!;
    if (a.name === 'xmlns') scope.set('', a.value);
    else if (a.name.startsWith('xmlns:')) scope.set(a.name.slice(6), a.value);
  }
}

function renderElement(
  el: XElement,
  parentScope: Map<string, string>,
  renderedScope: Map<string, string>,
  out: string[],
  exclude: (el: XElement) => boolean,
): void {
  const scope = new Map(parentScope);
  applyDeclarations(el, scope);

  // Namespace axis: decide which declarations must be (re)rendered on this element.
  const nsToRender: Array<[string, string]> = [];
  for (const [prefix, uri] of scope) {
    if (prefix === 'xml') continue;
    if (prefix === '' && uri === '') {
      const parentDefault = renderedScope.get('');
      if (parentDefault !== undefined && parentDefault !== '') nsToRender.push(['', '']);
      continue;
    }
    if (renderedScope.get(prefix) !== uri) nsToRender.push([prefix, uri]);
  }
  nsToRender.sort((a, b) => compareCodeUnits(a[0], b[0]));

  // Ordinary attributes, sorted by (namespace URI, local name).
  const plainAttrs: Array<{ uri: string; local: string; name: string; value: string }> = [];
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)!;
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:') || a.namespaceURI === NS.xmlns) continue;
    plainAttrs.push({
      uri: a.namespaceURI ?? '',
      local: a.localName ?? a.name,
      name: a.name,
      value: a.value,
    });
  }
  plainAttrs.sort((a, b) => compareCodeUnits(a.uri, b.uri) || compareCodeUnits(a.local, b.local));

  out.push('<', el.tagName);
  for (const [prefix, uri] of nsToRender) {
    out.push(' ', prefix === '' ? 'xmlns' : `xmlns:${prefix}`, '="', escapeAttr(uri), '"');
  }
  for (const a of plainAttrs) out.push(' ', a.name, '="', escapeAttr(a.value), '"');
  out.push('>');

  for (let c = el.firstChild; c; c = c.nextSibling) {
    switch (c.nodeType) {
      case 1: {
        const childEl = c as XElement;
        if (!exclude(childEl)) renderElement(childEl, scope, scope, out, exclude);
        break;
      }
      case 3: // text
      case 4: // CDATA is rendered as escaped text
        out.push(escapeText((c as CharacterData).data));
        break;
      case 7: {
        const pi = c as ProcessingInstruction;
        out.push('<?', pi.target, pi.data ? ` ${pi.data}` : '', '?>');
        break;
      }
      // comments (8) are dropped
    }
  }
  out.push('</', el.tagName, '>');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/** C14N sorts by UCS code point; for the BMP-only names in XML this equals code-unit order. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
