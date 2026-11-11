import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NS, child, descendants, parseXml, text } from '../src/dom.js';
import { base64ToBytes, bytesToBase64 } from '../src/encoding.js';
import { computeInvoiceHash } from '../src/hash.js';
import { verifyEcdsa } from '../src/keys.js';
import { decodeQr } from '../src/qr.js';
import { SigningError, signInvoice } from '../src/sign.js';
import { extractSignedPropertiesText, signedPropertiesDigest } from '../src/signed-properties.js';
import { parseCertificate, zatcaCertDigest } from '../src/x509.js';
import { buildInvoiceXml } from '../src/xml-builder.js';
import { sampleInput } from './fixtures/sample-input.js';
import { TEST_CERTIFICATE_PEM, TEST_PRIVATE_KEY_PEM } from './fixtures/self-signed.js';

const SDK_DATA = join(__dirname, '../../../reference-samples/zatca-sdk/extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/Data');
const haveSdk = existsSync(SDK_DATA);


/** Independently re-check a signed document the way ZATCA's validator does. */
function assertConformant(xml: string, certificate: string) {
  const doc = parseXml(xml);
  const root = doc.documentElement as Element;
  const sig = descendants(root, NS.ds, 'Signature')[0]!;
  const refs = descendants(sig, NS.ds, 'Reference');
  const cert = parseCertificate(certificate);
  const hash = computeInvoiceHash(xml);

  expect(text(child(refs[0]!, NS.ds, 'DigestValue'))).toBe(hash);
  const sigValue = text(descendants(sig, NS.ds, 'SignatureValue')[0])!;
  expect(verifyEcdsa(base64ToBytes(sigValue), base64ToBytes(hash), cert.publicKeyPoint)).toBe(true);
  expect(text(child(refs[1]!, NS.ds, 'DigestValue'))).toBe(signedPropertiesDigest(extractSignedPropertiesText(xml)!));
  expect(text(descendants(descendants(sig, NS.xades, 'CertDigest')[0]!, NS.ds, 'DigestValue')[0])).toBe(zatcaCertDigest(cert));

  const qrRef = descendants(root, NS.cac, 'AdditionalDocumentReference').find((r) => text(child(r, NS.cbc, 'ID')) === 'QR')!;
  const { fields, warnings } = decodeQr(text(descendants(qrRef, NS.cbc, 'EmbeddedDocumentBinaryObject')[0])!);
  expect(warnings).toEqual([]);
  expect(fields.invoiceHash).toBe(hash);
  expect(fields.signature).toBe(sigValue);
  expect(bytesToBase64(fields.publicKey!)).toBe(bytesToBase64(cert.publicKeySpki));
  return { fields };
}

describe('buildInvoiceXml + signInvoice', () => {
  it('produces a self-consistent signed simplified invoice (self-signed test cert)', () => {
    const { xml } = buildInvoiceXml(sampleInput);
    const signed = signInvoice(xml, { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM }, { signingTime: new Date('2026-11-10T11:05:00Z') });
    expect(signed.signingTime).toBe('2026-11-10T11:05:00');
    const { fields } = assertConformant(signed.xml, TEST_CERTIFICATE_PEM);
    expect(fields.timestamp).toBe('2026-11-10T14:05:00');
    expect(fields.totalWithVat).toBe('231.15');
    expect(fields.vatTotal).toBe('30.15');
    expect(fields.certificateSignature).toBeDefined(); // simplified => tag 9
  });

  it('computes the same totals as ZATCA\'s official Simplified_Invoice sample', () => {
    const { totals, xml } = buildInvoiceXml(sampleInput);
    expect(totals.lineExtensionAmount.toFixed()).toBe('201.00');
    expect(totals.taxAmount.toFixed()).toBe('30.15');
    expect(totals.taxInclusiveAmount.toFixed()).toBe('231.15');
    expect(totals.lines.map((l) => l.vatAmount.toFixed())).toEqual(['14.85', '15.30']);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
  });

  it('omits QR tag 9 on standard invoices and uses LF only', () => {
    const { xml } = buildInvoiceXml({
      ...sampleInput,
      kind: 'standard',
      supplyDate: '2026-11-10',
      buyer: {
        name: 'Fatoora Samples LTD',
        vatNumber: '399999999800003',
        address: { street: 'Salah Al-Din', buildingNumber: '1111', district: 'Al-Murooj', city: 'Riyadh', postalCode: '12222', country: 'SA' },
      },
    });
    expect(xml).not.toContain('\r');
    const signed = signInvoice(xml, { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM });
    const { fields } = assertConformant(signed.xml, TEST_CERTIFICATE_PEM);
    expect(fields.certificateSignature).toBeUndefined();
  });

  it('builds credit notes with billing reference and reason', () => {
    const { xml } = buildInvoiceXml({ ...sampleInput, type: 'credit-note', billingReference: 'SME00010', reason: 'Goods returned' });
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:InstructionNote>Goods returned</cbc:InstructionNote>');
    expect(xml).toMatch(/<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>SME00010<\/cbc:ID>/);
    expect(() => buildInvoiceXml({ ...sampleInput, type: 'credit-note' })).toThrow(/billingReference/);
  });

  it('uses BER long-form QR lengths for long Arabic seller names', () => {
    const longName = 'شركة '.repeat(20).trim(); // 179 UTF-8 bytes: needs 0x81 LL
    const { xml } = buildInvoiceXml({ ...sampleInput, seller: { ...sampleInput.seller, name: longName } });
    const signed = signInvoice(xml, { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM });
    const raw = base64ToBytes(signed.qr);
    expect([raw[1], raw[2]]).toEqual([0x81, 179]);
    expect(decodeQr(signed.qr).fields.sellerName).toBe(longName);

    const veryLong = 'شركة '.repeat(30).trim(); // 269 bytes: needs 0x82 HH LL
    const qr2 = signInvoice(buildInvoiceXml({ ...sampleInput, seller: { ...sampleInput.seller, name: veryLong } }).xml, {
      privateKey: TEST_PRIVATE_KEY_PEM,
      certificate: TEST_CERTIFICATE_PEM,
    }).qr;
    expect([...base64ToBytes(qr2).subarray(1, 4)]).toEqual([0x82, 0x01, 0x0d]);
    expect(decodeQr(qr2).fields.sellerName).toBe(veryLong);
  });

  it('refuses mismatched keys and already-signed documents with clear errors', () => {
    const { xml } = buildInvoiceXml(sampleInput);
    const otherKey = 'a'.repeat(64);
    expect(() => signInvoice(xml, { privateKey: otherKey, certificate: TEST_CERTIFICATE_PEM })).toThrow(/does not match the certificate/);
    const signed = signInvoice(xml, { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM });
    expect(() => signInvoice(signed.xml, { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM })).toThrow(SigningError);
  });
});

describe.skipIf(!haveSdk)('signing with ZATCA\'s dummy sandbox credentials', () => {
  const certificate = haveSdk ? readFileSync(join(SDK_DATA, 'Certificates/cert.pem'), 'utf8') : '';
  const privateKey = haveSdk ? readFileSync(join(SDK_DATA, 'Certificates/ec-secp256k1-priv-key.pem'), 'utf8') : '';

  it('signs a built invoice that passes every conformance check', () => {
    const { xml } = buildInvoiceXml(sampleInput);
    assertConformant(signInvoice(xml, { privateKey, certificate }).xml, certificate);
  });

  /** Strip ZATCA's signature blocks from an official sample, re-sign, and expect ZATCA's own hash. */
  function unsign(xml: string): string {
    return xml
      .replace(/\r\n?/g, '\n')
      .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '')
      .replace(/<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/, '')
      .replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '');
  }

  const list = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? list(p) : n.endsWith('.xml') ? [p] : [];
    });

  for (const file of haveSdk ? list(join(SDK_DATA, 'Samples')) : []) {
    it(`re-signing ${file.split(/[\\/]/).slice(-2).join('/')} reproduces ZATCA's invoice hash`, () => {
      const original = readFileSync(file, 'utf8');
      const originalHash = computeInvoiceHash(original);
      const resigned = signInvoice(unsign(original), { privateKey, certificate });
      expect(resigned.invoiceHash).toBe(originalHash);
      assertConformant(resigned.xml, certificate);
    });
  }
});
