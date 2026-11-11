import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { parseDer } from '../src/asn1.js';
import { bytesToHex, utf8Encode } from '../src/encoding.js';
import {
  generateKeyPair,
  parsePrivateKey,
  privateKeyToPem,
  publicKeyFromPrivate,
  publicKeyToSpki,
  signEcdsa,
  verifyEcdsa,
} from '../src/keys.js';
import { certificateHashHex, formatName, parseCertificate } from '../src/x509.js';
import { TEST_CERTIFICATE_FACTS, TEST_CERTIFICATE_PEM, TEST_PRIVATE_KEY_PEM } from './fixtures/self-signed.js';

describe('X.509 parsing', () => {
  const cert = parseCertificate(TEST_CERTIFICATE_PEM);

  it('reads serial, issuer and hashes exactly as openssl does', () => {
    expect(cert.serialNumber).toBe(BigInt(`0x${TEST_CERTIFICATE_FACTS.serialHex}`));
    expect(formatName(cert.issuer)).toBe(TEST_CERTIFICATE_FACTS.issuer);
    expect(bytesToHex(sha256(cert.publicKeySpki))).toBe(TEST_CERTIFICATE_FACTS.spkiSha256Hex);
    expect(certificateHashHex(cert)).toBe(TEST_CERTIFICATE_FACTS.derSha256Hex);
  });

  it('reads the signature algorithm and validity window', () => {
    expect(cert.signatureAlgorithmOid).toBe('1.2.840.10045.4.3.2'); // ecdsa-with-SHA256
    expect(cert.notAfter.getTime()).toBeGreaterThan(cert.notBefore.getTime());
    expect(cert.signatureValue[0]).toBe(0x30); // DER ECDSA signature
  });

  it('accepts bare base64 and base64-of-base64 (ZATCA binarySecurityToken) forms', () => {
    expect(parseCertificate(cert.base64).serialNumber).toBe(cert.serialNumber);
    expect(parseCertificate(btoa(cert.base64)).serialNumber).toBe(cert.serialNumber);
  });
});

describe('secp256k1 keys', () => {
  it('reads the openssl SEC1 key and matches the certificate public key', () => {
    const priv = parsePrivateKey(TEST_PRIVATE_KEY_PEM);
    const cert = parseCertificate(TEST_CERTIFICATE_PEM);
    expect(publicKeyFromPrivate(priv)).toEqual(cert.publicKeyPoint);
    expect(publicKeyToSpki(publicKeyFromPrivate(priv))).toEqual(cert.publicKeySpki);
  });

  it('reads the bare base64 key body that ZATCA tooling uses', () => {
    const bare = TEST_PRIVATE_KEY_PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    expect(parsePrivateKey(bare)).toEqual(parsePrivateKey(TEST_PRIVATE_KEY_PEM));
  });

  it('round-trips through PEM and signs/verifies', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(parsePrivateKey(privateKeyToPem(privateKey))).toEqual(privateKey);
    const msg = utf8Encode('invoice hash');
    const sig = signEcdsa(msg, privateKey);
    expect(sig[0]).toBe(0x30);
    expect(verifyEcdsa(sig, msg, publicKey)).toBe(true);
    expect(verifyEcdsa(sig, utf8Encode('tampered'), publicKey)).toBe(false);
  });

  it('verifies the self-signed certificate\'s own signature over its TBS', () => {
    const cert = parseCertificate(TEST_CERTIFICATE_PEM);
    // TBSCertificate is the first child of the certificate SEQUENCE.
    const tbs = parseDer(cert.der).children[0]!.der;
    expect(verifyEcdsa(cert.signatureValue, tbs, cert.publicKeyPoint)).toBe(true);
  });
});

describe('createTestCertificate', () => {
  it('builds a self-signed cert that parses, verifies and signs invoices', async () => {
    const { createTestCertificate } = await import('../src/test-certificate.js');
    const { generateKeyPair } = await import('../src/keys.js');
    const { privateKey, publicKey } = generateKeyPair();
    const certB64 = createTestCertificate(privateKey, { commonName: 'DEMO' });
    const cert = parseCertificate(certB64);
    expect(cert.publicKeyPoint).toEqual(publicKey);
    expect(formatName(cert.issuer)).toBe('CN=DEMO, OU=Test Branch, O=Test Organisation, C=SA');
    const tbs = parseDer(cert.der).children[0]!.der;
    expect(verifyEcdsa(cert.signatureValue, tbs, publicKey)).toBe(true);
  });
});
