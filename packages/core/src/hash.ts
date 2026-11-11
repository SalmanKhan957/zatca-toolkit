import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalize } from './c14n.js';
import { NS, type XDocument, type XElement, child, parseXml } from './dom.js';
import { bytesToBase64, utf8Encode } from './encoding.js';

/**
 * PIH for the very first document of an EGS unit: base64 of the *hex text* of
 * SHA-256("0"). It is the only PIH that is base64-of-hex (88 chars); every later PIH is
 * the previous document's invoice hash (base64 of raw bytes, 44 chars).
 */
export const INITIAL_PREVIOUS_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/**
 * The three elements ZATCA strips before hashing (mirrors the SDK's removeElements.xsl):
 * any UBLExtensions under Invoice, Invoice/cac:Signature, and the QR
 * AdditionalDocumentReference. Matching is by local name, as the SDK's XSLT does.
 */
export function isExcludedFromHash(el: XElement): boolean {
  const local = el.localName;
  if (local === 'UBLExtensions') return true;
  const parent = el.parentNode as XElement | null;
  const parentIsRoot = !!parent && parent.nodeType === 1 && parent.parentNode?.nodeType === 9;
  if (local === 'Signature' && parentIsRoot) return true;
  if (local === 'AdditionalDocumentReference') {
    const id = child(el, NS.cbc, 'ID');
    if (id && (id.textContent ?? '').trim() === 'QR') return true;
  }
  return false;
}

/** Canonical bytes ZATCA hashes: C14N of the document minus the three excluded elements. */
export function canonicalInvoice(xml: string | XDocument): string {
  const doc = typeof xml === 'string' ? parseXml(xml) : xml;
  return canonicalize(doc, { exclude: isExcludedFromHash });
}

/** SHA-256 of the canonical invoice (32 raw bytes). */
export function invoiceHashBytes(xml: string | XDocument): Uint8Array {
  return sha256(utf8Encode(canonicalInvoice(xml)));
}

/**
 * ZATCA invoice hash: base64 of the raw SHA-256 bytes (44 characters). This value goes
 * in ds:DigestValue, QR tag 6, the API `invoiceHash` field, and the next document's PIH.
 */
export function computeInvoiceHash(xml: string | XDocument): string {
  return bytesToBase64(invoiceHashBytes(xml));
}
