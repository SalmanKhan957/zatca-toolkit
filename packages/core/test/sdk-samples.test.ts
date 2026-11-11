/**
 * Conformance suite against ZATCA's official signed samples (SDK 3.4.8).
 *
 * The samples are LGPL-3.0 and are not redistributed in this repository. Download the SDK
 * (see reference-samples/SOURCES.md) and extract it under reference-samples/zatca-sdk/extracted/
 * to run these tests; they are skipped when the files are absent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NS, child, descendants, parseXml, path, text } from '../src/dom.js';
import { base64ToBytes, bytesToBase64, bytesToHex } from '../src/encoding.js';
import { INITIAL_PREVIOUS_INVOICE_HASH, computeInvoiceHash } from '../src/hash.js';
import { parsePrivateKey, publicKeyFromPrivate, verifyEcdsa } from '../src/keys.js';
import { decodeQr } from '../src/qr.js';
import { extractSignedPropertiesText, signedPropertiesDigest } from '../src/signed-properties.js';
import { formatName, parseCertificate, zatcaCertDigest } from '../src/x509.js';

const SDK_ROOT = join(__dirname, '../../../reference-samples/zatca-sdk/extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/Data');
const haveSdk = existsSync(SDK_ROOT);

function listXml(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listXml(p));
    else if (name.endsWith('.xml')) out.push(p);
  }
  return out.sort();
}

describe.skipIf(!haveSdk)('ZATCA SDK 3.4.8 official samples', () => {
  const samples = haveSdk ? listXml(join(SDK_ROOT, 'Samples')) : [];
  const certText = haveSdk ? readFileSync(join(SDK_ROOT, 'Certificates/cert.pem'), 'utf8') : '';
  const keyText = haveSdk ? readFileSync(join(SDK_ROOT, 'Certificates/ec-secp256k1-priv-key.pem'), 'utf8') : '';

  it('finds all 19 samples', () => {
    expect(samples).toHaveLength(19);
  });

  it('dummy key matches dummy certificate, and certificate facts match the spec', () => {
    const cert = parseCertificate(certText);
    expect(publicKeyFromPrivate(parsePrivateKey(keyText))).toEqual(cert.publicKeyPoint);
    expect(formatName(cert.issuer)).toBe('CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local');
    expect(cert.serialNumber.toString(10)).toBe('379112742831380471835263969587287663520528387');
    expect(zatcaCertDigest(cert)).toBe('ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==');
    expect(bytesToHex(cert.signatureValue)).toBe(
      '3045022100b13f89c8669d65c250a51b71adf2722f28ab068bbc574756342bbde23dbaa01b02203d842e0cf2380c0400cf4b399ddae88f240ea0291dcb134dd4ef97aa6c2feb5c',
    );
  });

  it('initial PIH is base64 of hex(sha256("0"))', () => {
    expect(INITIAL_PREVIOUS_INVOICE_HASH).toBe(readFileSync(join(SDK_ROOT, 'PIH/pih.txt'), 'utf8').trim());
  });

  for (const file of samples) {
    const name = haveSdk ? relative(join(SDK_ROOT, 'Samples'), file) : file;

    describe(name, () => {
      const xml = readFileSync(file, 'utf8');
      const doc = parseXml(xml);
      const root = doc.documentElement as Element;
      const sigEl = descendants(root, NS.ds, 'Signature')[0]!;
      const refs = descendants(sigEl, NS.ds, 'Reference');
      const invoiceRef = refs.find((r) => r.getAttribute('Id') === 'invoiceSignedData')!;
      const propsRef = refs.find((r) => r.getAttribute('URI') === '#xadesSignedProperties')!;
      const certB64 = text(descendants(sigEl, NS.ds, 'X509Certificate')[0])!.trim();
      const cert = parseCertificate(certB64);

      it('invoice hash matches ds:DigestValue', () => {
        expect(computeInvoiceHash(xml)).toBe(text(child(invoiceRef, NS.ds, 'DigestValue')));
      });

      it('ECDSA SignatureValue verifies over the raw hash bytes', () => {
        const hash = base64ToBytes(computeInvoiceHash(xml));
        const sig = base64ToBytes(text(descendants(sigEl, NS.ds, 'SignatureValue')[0])!);
        expect(verifyEcdsa(sig, hash, cert.publicKeyPoint)).toBe(true);
      });

      it('CertDigest, issuer and serial match the embedded certificate', () => {
        expect(text(descendants(sigEl, NS.xades, 'CertDigest')[0] && descendants(descendants(sigEl, NS.xades, 'CertDigest')[0]!, NS.ds, 'DigestValue')[0])).toBe(zatcaCertDigest(cert));
        expect(text(descendants(sigEl, NS.ds, 'X509IssuerName')[0])).toBe(formatName(cert.issuer));
        expect(text(descendants(sigEl, NS.ds, 'X509SerialNumber')[0])).toBe(cert.serialNumber.toString(10));
      });

      it('SignedProperties digest matches its reference', () => {
        const spText = extractSignedPropertiesText(xml)!;
        expect(signedPropertiesDigest(spText)).toBe(text(child(propsRef, NS.ds, 'DigestValue')));
      });

      it('QR tags agree with the XML, hash, signature and certificate', () => {
        const qrRef = descendants(root, NS.cac, 'AdditionalDocumentReference').find((r) => text(child(r, NS.cbc, 'ID'))?.trim() === 'QR')!;
        const qrText = text(path(qrRef, [NS.cac, 'Attachment'], [NS.cbc, 'EmbeddedDocumentBinaryObject']))!.trim();
        const { fields, warnings } = decodeQr(qrText);
        expect(warnings).toEqual([]);

        const supplier = path(root, [NS.cac, 'AccountingSupplierParty'], [NS.cac, 'Party'])!;
        expect(fields.sellerName).toBe(text(path(supplier, [NS.cac, 'PartyLegalEntity'], [NS.cbc, 'RegistrationName'])));
        expect(fields.vatNumber).toBe(text(path(supplier, [NS.cac, 'PartyTaxScheme'], [NS.cbc, 'CompanyID'])));
        expect(fields.timestamp).toBe(`${text(child(root, NS.cbc, 'IssueDate'))}T${text(child(root, NS.cbc, 'IssueTime'))}`);
        expect(fields.vatTotal).toBe(text(path(root, [NS.cac, 'TaxTotal'], [NS.cbc, 'TaxAmount'])));
        expect(fields.invoiceHash).toBe(computeInvoiceHash(xml));
        expect(fields.signature).toBe(text(descendants(sigEl, NS.ds, 'SignatureValue')[0]));
        expect(bytesToBase64(fields.publicKey!)).toBe(bytesToBase64(cert.publicKeySpki));
        const isSimplified = child(root, NS.cbc, 'InvoiceTypeCode')!.getAttribute('name')!.startsWith('02');
        if (isSimplified) expect(bytesToHex(fields.certificateSignature!)).toBe(bytesToHex(cert.signatureValue));
      });
    });
  }
});
