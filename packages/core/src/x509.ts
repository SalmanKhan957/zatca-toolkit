import { sha256 } from '@noble/hashes/sha2.js';
import { type Asn1Node, TAG, decodeInteger, decodeOid, decodeString, parseDer } from './asn1.js';
import { bytesToBase64, bytesToHex, pemToDer, utf8Encode } from './encoding.js';

/** Short names for the attribute OIDs that appear in ZATCA certificates. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.15': 'businessCategory',
  '2.5.4.26': 'registeredAddress',
  '2.5.4.97': 'organizationIdentifier',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
  '1.2.840.113549.1.9.1': 'E',
};

export interface NameAttribute {
  oid: string;
  name: string;
  value: string;
}

export interface ParsedCertificate {
  /** DER bytes of the whole certificate */
  der: Uint8Array;
  /** Base64 of the DER (the form ZATCA puts in ds:X509Certificate) */
  base64: string;
  serialNumber: bigint;
  /** RDNs in certificate (encoding) order */
  issuer: NameAttribute[][];
  subject: NameAttribute[][];
  notBefore: Date;
  notAfter: Date;
  /** DER SubjectPublicKeyInfo (QR tag 8) */
  publicKeySpki: Uint8Array;
  /** Uncompressed EC point (0x04 || X || Y) */
  publicKeyPoint: Uint8Array;
  signatureAlgorithmOid: string;
  /** Raw signatureValue bytes - the issuing CA's signature (QR tag 9) */
  signatureValue: Uint8Array;
}

/** Accepts PEM, bare base64 of the DER, or ZATCA's "base64 of base64" binarySecurityToken. */
export function parseCertificate(input: string | Uint8Array): ParsedCertificate {
  const derBytes = typeof input === 'string' ? certificateDerFromString(input) : input;
  const root = parseDer(derBytes);
  const [tbs, sigAlg, sigValue] = root.children;
  if (!tbs || !sigAlg || !sigValue) throw new Error('Not an X.509 certificate');

  let i = 0;
  // Optional explicit [0] version
  if (tbs.children[0]?.tag === 0xa0) i++;
  const serialNode = tbs.children[i++]!;
  i++; // signature algorithm inside TBS
  const issuerNode = tbs.children[i++]!;
  const validityNode = tbs.children[i++]!;
  const subjectNode = tbs.children[i++]!;
  const spkiNode = tbs.children[i++]!;

  const spkiBitString = spkiNode.children[1]!;
  return {
    der: derBytes,
    base64: bytesToBase64(derBytes),
    serialNumber: decodeInteger(serialNode.content),
    issuer: parseName(issuerNode),
    subject: parseName(subjectNode),
    notBefore: parseTime(validityNode.children[0]!),
    notAfter: parseTime(validityNode.children[1]!),
    publicKeySpki: spkiNode.der.slice(),
    publicKeyPoint: spkiBitString.content.slice(1),
    signatureAlgorithmOid: decodeOid(sigAlg.children[0]!.content),
    signatureValue: sigValue.content.slice(1),
  };
}

function certificateDerFromString(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.includes('-----BEGIN')) return pemToDer(trimmed);
  const der = pemToDer(trimmed);
  // A DER certificate starts with 0x30 (SEQUENCE). If not, it may be base64-of-base64.
  if (der[0] === TAG.SEQUENCE) return der;
  return pemToDer(new TextDecoder().decode(der));
}

function parseName(node: Asn1Node): NameAttribute[][] {
  return node.children.map((rdnSet) =>
    rdnSet.children.map((atv) => {
      const oid = decodeOid(atv.children[0]!.content);
      return { oid, name: ATTRIBUTE_NAMES[oid] ?? oid, value: decodeString(atv.children[1]!) };
    }),
  );
}

function parseTime(node: Asn1Node): Date {
  const s = decodeString(node);
  if (node.tag === TAG.UTC_TIME) {
    // YYMMDDHHMMSSZ
    const yy = Number(s.slice(0, 2));
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))));
  }
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14))));
}

/**
 * Format a distinguished name. ZATCA's XAdES IssuerName uses the reverse of encoding
 * order joined with ", " (e.g. "CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local").
 */
export function formatName(rdns: NameAttribute[][], options: { reverse?: boolean; separator?: string } = {}): string {
  const { reverse = true, separator = ', ' } = options;
  const ordered = reverse ? [...rdns].reverse() : rdns;
  return ordered.map((rdn) => rdn.map((a) => `${a.name}=${escapeDnValue(a.value)}`).join('+')).join(separator);
}

function escapeDnValue(v: string): string {
  return v.replace(/([,+"\\<>;=])/g, '\\$1').replace(/^([ #])/, '\\$1').replace(/ $/, '\\ ');
}

/** SHA-256 of the certificate DER, as lowercase hex. */
export function certificateHashHex(cert: ParsedCertificate): string {
  return bytesToHex(sha256(cert.der));
}

/** ZATCA's CertDigest: base64 of the *hex text* of SHA-256 over the base64 certificate text. */
export function zatcaCertDigest(cert: ParsedCertificate): string {
  return bytesToBase64(utf8Encode(bytesToHex(sha256(utf8Encode(cert.base64)))));
}
