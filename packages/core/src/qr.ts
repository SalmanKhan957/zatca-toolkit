import { base64ToBytes, bytesToBase64, concatBytes, utf8Decode, utf8Encode } from './encoding.js';

/**
 * ZATCA QR payload: a sequence of Tag-Length-Value records, base64-encoded.
 *
 * Tags 1-5 are text (UTF-8). Tags 6 and 7 carry base64 *text* (the invoice hash and
 * the ECDSA signature). Tags 8 and 9 carry raw bytes (the public key DER, and the
 * certificate's signature from ZATCA's CA, which only simplified invoices include).
 */
export interface QrFields {
  /** Tag 1 - seller name */
  sellerName: string;
  /** Tag 2 - seller VAT registration number (15 digits) */
  vatNumber: string;
  /** Tag 3 - invoice timestamp, e.g. 2026-11-10T14:05:00 */
  timestamp: string;
  /** Tag 4 - invoice total including VAT, as a decimal string */
  totalWithVat: string;
  /** Tag 5 - VAT total, as a decimal string */
  vatTotal: string;
  /** Tag 6 - invoice hash (base64 text) */
  invoiceHash?: string;
  /** Tag 7 - ECDSA signature over the invoice hash (base64 text) */
  signature?: string;
  /** Tag 8 - ECDSA public key (DER SubjectPublicKeyInfo bytes) */
  publicKey?: Uint8Array;
  /** Tag 9 - the signature ZATCA's CA put on the stamp certificate (simplified invoices only) */
  certificateSignature?: Uint8Array;
}

/**
 * BER length encoding, as used by ZATCA's own QR generator and validator (the SDK uses
 * the payneteasy BerTlvBuilder/BerTlvParser): values under 128 bytes take one length
 * byte; longer values use the long form 0x81 LL or 0x82 HH LL.
 *
 * Many libraries write a single byte for 128-255, which ZATCA's BER parser misreads.
 * Long Arabic seller names (about 64+ characters = 128+ UTF-8 bytes) trigger this.
 */
function berLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  if (len < 0x10000) return new Uint8Array([0x82, len >> 8, len & 0xff]);
  throw new Error(`QR value of ${len} bytes is too long`);
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), berLength(value.length), value);
}

/** ZATCA rejects QR payloads longer than this many base64 characters (BR-CL-KSA-14). */
export const QR_MAX_BASE64_LENGTH = 1000;

export function encodeQr(fields: QrFields): string {
  const parts: Uint8Array[] = [
    tlv(1, utf8Encode(fields.sellerName)),
    tlv(2, utf8Encode(fields.vatNumber)),
    tlv(3, utf8Encode(fields.timestamp)),
    tlv(4, utf8Encode(fields.totalWithVat)),
    tlv(5, utf8Encode(fields.vatTotal)),
  ];
  if (fields.invoiceHash !== undefined) parts.push(tlv(6, utf8Encode(fields.invoiceHash)));
  if (fields.signature !== undefined) parts.push(tlv(7, utf8Encode(fields.signature)));
  if (fields.publicKey !== undefined) parts.push(tlv(8, fields.publicKey));
  if (fields.certificateSignature !== undefined) parts.push(tlv(9, fields.certificateSignature));
  return bytesToBase64(concatBytes(...parts));
}

export interface DecodedQrTag {
  tag: number;
  length: number;
  /** UTF-8 text for tags 1-7; base64 of the raw bytes for tags 8-9 and unknown tags */
  value: string;
  raw: Uint8Array;
}

export interface DecodedQr {
  tags: DecodedQrTag[];
  fields: Partial<QrFields>;
  /**
   * Problems that ZATCA's BER-based parser would trip on, e.g. a single-byte length of
   * 128+ written by a non-BER encoder. The payload was still decoded leniently.
   */
  warnings: string[];
}

/** Decode a ZATCA QR payload. Throws on truncated or malformed TLV data. */
export function decodeQr(base64Payload: string): DecodedQr {
  const bytes = base64ToBytes(base64Payload);
  const tags: DecodedQrTag[] = [];
  const warnings: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) throw new Error(`Truncated QR TLV header at byte ${i}`);
    const tag = bytes[i]!;
    const first = bytes[i + 1]!;
    let length: number;
    let start: number;
    if (first < 0x80) {
      length = first;
      start = i + 2;
    } else {
      const n = first & 0x7f;
      const berOk = n >= 1 && n <= 2 && i + 2 + n <= bytes.length;
      const berLen = berOk ? (n === 1 ? bytes[i + 2]! : (bytes[i + 2]! << 8) | bytes[i + 3]!) : -1;
      if (berOk && i + 2 + n + berLen <= bytes.length) {
        length = berLen;
        start = i + 2 + n;
      } else if (i + 2 + first <= bytes.length) {
        // Legacy single-byte length >= 128: readable, but ZATCA's parser will reject it.
        length = first;
        start = i + 2;
        warnings.push(
          `Tag ${tag} uses a single-byte length of ${first}. ZATCA parses QR lengths as BER, where values of 128+ bytes need the long form (0x81 ${first.toString(16)}). ZATCA will likely reject this QR.`,
        );
      } else {
        throw new Error(`QR tag ${tag} has an invalid length encoding`);
      }
    }
    const end = start + length;
    if (end > bytes.length) throw new Error(`QR tag ${tag} declares ${length} bytes but only ${bytes.length - start} remain`);
    const raw = bytes.slice(start, end);
    let value: string;
    if (tag >= 1 && tag <= 7) {
      try {
        value = utf8Decode(raw);
      } catch {
        throw new Error(`QR tag ${tag} is not valid UTF-8 text`);
      }
    } else {
      value = bytesToBase64(raw);
    }
    tags.push({ tag, length, value, raw });
    i = end;
  }

  const fields: Partial<QrFields> = {};
  for (const t of tags) {
    switch (t.tag) {
      case 1: fields.sellerName = t.value; break;
      case 2: fields.vatNumber = t.value; break;
      case 3: fields.timestamp = t.value; break;
      case 4: fields.totalWithVat = t.value; break;
      case 5: fields.vatTotal = t.value; break;
      case 6: fields.invoiceHash = t.value; break;
      case 7: fields.signature = t.value; break;
      case 8: fields.publicKey = t.raw; break;
      case 9: fields.certificateSignature = t.raw; break;
    }
  }
  if (base64Payload.replace(/\s+/g, '').length > QR_MAX_BASE64_LENGTH) {
    warnings.push(`QR payload is longer than ${QR_MAX_BASE64_LENGTH} base64 characters (BR-CL-KSA-14).`);
  }
  return { tags, fields, warnings };
}
