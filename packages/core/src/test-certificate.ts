import { TAG, der, tlv } from './asn1.js';
import { bytesToBase64, utf8Encode } from './encoding.js';
import { publicKeyFromPrivate, publicKeyToSpki, signEcdsa } from './keys.js';

export interface TestCertificateOptions {
  commonName?: string;
  organization?: string;
  organizationUnit?: string;
  /** Validity in days from now (default 365) */
  days?: number;
}

function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(TAG.UTC_TIME, utf8Encode(s));
}

/**
 * Create a SELF-SIGNED secp256k1 certificate for tests and demos. ZATCA will not
 * accept invoices signed with it; real CSIDs come from ZATCA's onboarding API.
 * Returns the base64 DER (the same form as ds:X509Certificate).
 */
export function createTestCertificate(privateKey: Uint8Array, options: TestCertificateOptions = {}): string {
  const rdn = (oid: string, value: Uint8Array) => der.set(der.sequence(der.oid(oid), value));
  const name = der.sequence(
    rdn('2.5.4.6', der.printable('SA')),
    rdn('2.5.4.10', der.utf8(options.organization ?? 'Test Organisation')),
    rdn('2.5.4.11', der.utf8(options.organizationUnit ?? 'Test Branch')),
    rdn('2.5.4.3', der.utf8(options.commonName ?? 'TEST-ONLY-NOT-ZATCA-ISSUED')),
  );
  const now = new Date();
  const notAfter = new Date(now.getTime() + (options.days ?? 365) * 86_400_000);
  const serial = BigInt(`0x1${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(15)), (b) => b.toString(16).padStart(2, '0')).join('')}`);
  const algorithm = der.sequence(der.oid('1.2.840.10045.4.3.2'));
  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(serial),
    algorithm,
    name,
    der.sequence(utcTime(now), utcTime(notAfter)),
    name,
    publicKeyToSpki(publicKeyFromPrivate(privateKey)),
  );
  const certificate = der.sequence(tbs, algorithm, der.bitString(signEcdsa(tbs, privateKey)));
  return bytesToBase64(certificate);
}
