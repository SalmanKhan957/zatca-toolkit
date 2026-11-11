import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// xmldom's node types are structurally compatible with the DOM lib types we use.
export type XNode = Node;
export type XElement = Element;
export type XDocument = Document;

export const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  sig: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
  sac: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
  sbc: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
  xmlns: 'http://www.w3.org/2000/xmlns/',
} as const;

export class XmlParseError extends Error {}

/** Parse XML strictly: any parser warning or error throws. Line endings are normalised first. */
export function parseXml(xml: string): XDocument {
  const normalised = xml.replace(/\r\n?/g, '\n');
  const parser = new DOMParser({
    onError: (level: string, message: string) => {
      throw new XmlParseError(`XML ${level}: ${message}`);
    },
  });
  const doc = parser.parseFromString(normalised, 'text/xml') as unknown as XDocument;
  if (!doc || !doc.documentElement) throw new XmlParseError('XML has no root element');
  return doc;
}

export function serializeXml(node: XNode): string {
  return new XMLSerializer().serializeToString(node as never);
}

export function childElements(el: XElement): XElement[] {
  const out: XElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as XElement);
  return out;
}

/** First direct child element with the given namespace and local name. */
export function child(el: XElement, ns: string, localName: string): XElement | undefined {
  return childElements(el).find((c) => c.namespaceURI === ns && c.localName === localName);
}

export function children(el: XElement, ns: string, localName: string): XElement[] {
  return childElements(el).filter((c) => c.namespaceURI === ns && c.localName === localName);
}

/** Follow a path of [ns, localName] steps through direct children. */
export function path(el: XElement | undefined, ...steps: Array<[string, string]>): XElement | undefined {
  let cur = el;
  for (const [ns, name] of steps) {
    if (!cur) return undefined;
    cur = child(cur, ns, name);
  }
  return cur;
}

export function text(el: XElement | undefined): string | undefined {
  if (!el) return undefined;
  return el.textContent ?? undefined;
}

/** All descendant elements (document order) matching namespace + local name. */
export function descendants(root: XElement, ns: string, localName: string): XElement[] {
  const out: XElement[] = [];
  const walk = (el: XElement) => {
    for (const c of childElements(el)) {
      if (c.namespaceURI === ns && c.localName === localName) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
