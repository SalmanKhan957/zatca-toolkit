import { concatBytes, utf8Decode, utf8Encode } from './encoding.js';

/**
 * Minimal DER encoder/decoder: just enough ASN.1 to build a ZATCA CSR and to read
 * X.509 certificates (public key, signature, issuer, serial). Runs anywhere.
 */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

// ---------- encoding ----------

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), encodeLength(value.length), value);
}

export const der = {
  sequence: (...items: Uint8Array[]) => tlv(TAG.SEQUENCE, concatBytes(...items)),
  set: (...items: Uint8Array[]) => tlv(TAG.SET, concatBytes(...items)),
  null: () => new Uint8Array([TAG.NULL, 0]),
  boolean: (v: boolean) => tlv(TAG.BOOLEAN, new Uint8Array([v ? 0xff : 0])),
  utf8: (s: string) => tlv(TAG.UTF8_STRING, utf8Encode(s)),
  printable: (s: string) => tlv(TAG.PRINTABLE_STRING, utf8Encode(s)),
  octetString: (b: Uint8Array) => tlv(TAG.OCTET_STRING, b),
  /** BIT STRING with zero unused bits */
  bitString: (b: Uint8Array) => tlv(TAG.BIT_STRING, concatBytes(new Uint8Array([0]), b)),
  /** Context-specific constructed tag [n] */
  explicit: (n: number, content: Uint8Array) => tlv(0xa0 | n, content),
  /** Context-specific tag [n] with raw content (implicit) */
  implicitConstructed: (n: number, content: Uint8Array) => tlv(0xa0 | n, content),
  integer(value: bigint | number): Uint8Array {
    let v = BigInt(value);
    if (v < 0n) throw new Error('Negative INTEGER not supported');
    const bytes: number[] = [];
    do {
      bytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    } while (v > 0n);
    if (bytes[0]! & 0x80) bytes.unshift(0);
    return tlv(TAG.INTEGER, new Uint8Array(bytes));
  },
  oid(dotted: string): Uint8Array {
    const parts = dotted.split('.').map((p) => BigInt(p));
    if (parts.length < 2) throw new Error(`Bad OID ${dotted}`);
    const out: number[] = [Number(parts[0]! * 40n + parts[1]!)];
    for (const part of parts.slice(2)) {
      const chunk: number[] = [];
      let v = part;
      chunk.unshift(Number(v & 0x7fn));
      v >>= 7n;
      while (v > 0n) {
        chunk.unshift(Number((v & 0x7fn) | 0x80n));
        v >>= 7n;
      }
      out.push(...chunk);
    }
    return tlv(TAG.OID, new Uint8Array(out));
  },
};

// ---------- decoding ----------

export interface Asn1Node {
  tag: number;
  /** Full encoding of this node (header + content) */
  der: Uint8Array;
  /** Content bytes only */
  content: Uint8Array;
  children: Asn1Node[];
}

export function parseDer(bytes: Uint8Array): Asn1Node {
  const { node, end } = parseAt(bytes, 0);
  if (end !== bytes.length) throw new Error(`Trailing bytes after DER structure (${bytes.length - end})`);
  return node;
}

function parseAt(bytes: Uint8Array, offset: number): { node: Asn1Node; end: number } {
  if (offset + 2 > bytes.length) throw new Error('Truncated DER');
  const tag = bytes[offset]!;
  let lenByte = bytes[offset + 1]!;
  let headerLen = 2;
  let len: number;
  if (lenByte < 0x80) {
    len = lenByte;
  } else {
    const n = lenByte & 0x7f;
    if (n === 0 || n > 4) throw new Error('Unsupported DER length encoding');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[offset + 2 + i]!;
    headerLen += n;
  }
  const start = offset + headerLen;
  const end = start + len;
  if (end > bytes.length) throw new Error('DER length exceeds input');
  const content = bytes.subarray(start, end);
  const children: Asn1Node[] = [];
  const constructed = (tag & 0x20) !== 0;
  if (constructed) {
    let p = start;
    while (p < end) {
      const r = parseAt(bytes, p);
      children.push(r.node);
      p = r.end;
    }
  }
  return { node: { tag, der: bytes.subarray(offset, end), content, children }, end };
}

export function decodeOid(content: Uint8Array): string {
  const first = content[0]!;
  const parts: bigint[] = [BigInt(Math.floor(first / 40)), BigInt(first % 40)];
  let v = 0n;
  for (let i = 1; i < content.length; i++) {
    const b = content[i]!;
    v = (v << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(v);
      v = 0n;
    }
  }
  return parts.join('.');
}

export function decodeInteger(content: Uint8Array): bigint {
  let v = 0n;
  for (const b of content) v = (v << 8n) | BigInt(b);
  return v;
}

export function decodeString(node: Asn1Node): string {
  return utf8Decode(node.content);
}
