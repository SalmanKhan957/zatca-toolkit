import { sha256 } from '@noble/hashes/sha2.js';
import { NS } from './dom.js';
import { bytesToBase64, bytesToHex, utf8Encode } from './encoding.js';

/**
 * ZATCA's SignedProperties digest is NOT computed over C14N output. It is SHA-256 over the
 * <xades:SignedProperties> element text exactly as it appears in the document (same
 * indentation, self-closing empty tags, LF line endings), with namespace declarations
 * injected as the first attribute: xmlns:xades on SignedProperties, xmlns:ds on every ds:
 * element. The digest is then written as base64 of the lowercase *hex* string.
 * Verified byte-for-byte against all ZATCA SDK 3.4.8 samples.
 */
export function signedPropertiesHashInput(signedPropertiesText: string): string {
  let text = signedPropertiesText.replace(/\r\n?/g, '\n');
  text = text.replace(/^<xades:SignedProperties(?![^>]*xmlns:xades=)/, `<xades:SignedProperties xmlns:xades="${NS.xades}"`);
  text = text.replace(/<ds:([A-Za-z0-9]+)(?![^>]*xmlns:ds=)/g, `<ds:$1 xmlns:ds="${NS.ds}"`);
  return text;
}

export function signedPropertiesDigest(signedPropertiesText: string): string {
  const hex = bytesToHex(sha256(utf8Encode(signedPropertiesHashInput(signedPropertiesText))));
  return bytesToBase64(utf8Encode(hex));
}

/** Pull the raw <xades:SignedProperties>…</xades:SignedProperties> text out of a signed document. */
export function extractSignedPropertiesText(xml: string): string | undefined {
  const normalised = xml.replace(/\r\n?/g, '\n');
  const start = normalised.indexOf('<xades:SignedProperties');
  if (start < 0) return undefined;
  const closeTag = '</xades:SignedProperties>';
  const end = normalised.indexOf(closeTag, start);
  if (end < 0) return undefined;
  return normalised.slice(start, end + closeTag.length);
}
