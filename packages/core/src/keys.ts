import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TAG, decodeOid, der, parseDer } from './asn1.js';
import { derToPem, pemToDer } from './encoding.js';

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_SECP256K1 = '1.3.132.0.10';

export interface KeyPair {
  /** 32-byte secp256k1 private scalar */
  privateKey: Uint8Array;
  /** Uncompressed public point, 65 bytes (0x04 || X || Y) */
  publicKey: Uint8Array;
}

/** Generate a new secp256k1 key pair (the curve ZATCA requires) using a CSPRNG. */
export function generateKeyPair(): KeyPair {
  const privateKey = secp256k1.utils.randomSecretKey();
  return { privateKey, publicKey: secp256k1.getPublicKey(privateKey, false) };
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, false);
}

/** DER SubjectPublicKeyInfo for a secp256k1 public point. */
export function publicKeyToSpki(publicPoint: Uint8Array): Uint8Array {
  const point = publicPoint.length === 33 ? secp256k1.Point.fromBytes(publicPoint).toBytes(false) : publicPoint;
  return der.sequence(der.sequence(der.oid(OID_EC_PUBLIC_KEY), der.oid(OID_SECP256K1)), der.bitString(point));
}

/**
 * Read a secp256k1 private key from:
 *  - SEC1 PEM ("-----BEGIN EC PRIVATE KEY-----") or its bare base64 body
 *    (ZATCA's SDK ships keys in this bare form)
 *  - PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----")
 *  - a 64-character hex string
 */
export function parsePrivateKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const bytes = pemToDer(trimmed);
  const root = parseDer(bytes);
  const first = root.children[0];
  if (!first || first.tag !== TAG.INTEGER) throw new Error('Unrecognised private key structure');
  const version = first.content[first.content.length - 1];

  if (version === 1) {
    // SEC1 ECPrivateKey: { version 1, privateKey OCTET STRING, [0] params, [1] publicKey }
    const params = root.children.find((c) => c.tag === 0xa0);
    if (params) assertSecp256k1(decodeOid(params.children[0]!.content));
    return leftPad32(root.children[1]!.content);
  }
  if (version === 0) {
    // PKCS#8: { version 0, AlgorithmIdentifier, OCTET STRING (SEC1 ECPrivateKey) }
    const alg = root.children[1]!;
    if (decodeOid(alg.children[0]!.content) !== OID_EC_PUBLIC_KEY) throw new Error('PKCS#8 key is not an EC key');
    const curve = alg.children[1];
    if (curve && curve.tag === TAG.OID) assertSecp256k1(decodeOid(curve.content));
    const inner = parseDer(root.children[2]!.content);
    return leftPad32(inner.children[1]!.content);
  }
  throw new Error('Unsupported private key version');
}

/** Encode a private key as SEC1 PEM (the format openssl and ZATCA tooling use). */
export function privateKeyToPem(privateKey: Uint8Array): string {
  const publicKey = publicKeyFromPrivate(privateKey);
  const body = der.sequence(
    der.integer(1),
    der.octetString(privateKey),
    der.explicit(0, der.oid(OID_SECP256K1)),
    der.explicit(1, der.bitString(publicKey)),
  );
  return derToPem(body, 'EC PRIVATE KEY');
}

function assertSecp256k1(oid: string): void {
  if (oid !== OID_SECP256K1) throw new Error(`Key curve ${oid} is not secp256k1 (ZATCA requires secp256k1)`);
}

function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length === 32) return b.slice();
  if (b.length > 32) throw new Error('Private key longer than 32 bytes');
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

/** ECDSA-SHA256 signature (DER) over `message`. The message is hashed with SHA-256 first. */
export function signEcdsa(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return secp256k1.sign(message, privateKey, { prehash: true, format: 'der', lowS: true });
}

export function verifyEcdsa(signatureDer: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return secp256k1.verify(signatureDer, message, publicKey, { prehash: true, format: 'der', lowS: false });
  } catch {
    return false;
  }
}
