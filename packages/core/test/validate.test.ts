import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainCode } from '../src/catalog.js';
import { signInvoice } from '../src/sign.js';
import { validateInvoice } from '../src/validate.js';
import { buildInvoiceXml } from '../src/xml-builder.js';
import { TEST_CERTIFICATE_PEM, TEST_PRIVATE_KEY_PEM } from './fixtures/self-signed.js';
import { sampleInput } from './fixtures/sample-input.js';

const creds = { privateKey: TEST_PRIVATE_KEY_PEM, certificate: TEST_CERTIFICATE_PEM };
const codes = (r: ReturnType<typeof validateInvoice>) => [...r.errors, ...r.warnings].map((f) => f.code);

describe('validateInvoice', () => {
  it('passes a freshly built and signed simplified invoice with no findings', () => {
    const signed = signInvoice(buildInvoiceXml(sampleInput).xml, creds);
    const r = validateInvoice(signed.xml);
    expect(codes(r)).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.signed).toBe(true);
    expect(r.kind).toBe('simplified');
    expect(r.signatureChecks.length).toBeGreaterThanOrEqual(14);
    expect(r.signatureChecks.every((c) => c.passed)).toBe(true);
  });

  it('flags an unsigned simplified invoice (stamp and QR missing)', () => {
    const r = validateInvoice(buildInvoiceXml(sampleInput).xml);
    expect(codes(r).sort()).toEqual(['BR-KSA-27', 'BR-KSA-60']);
    expect(r.valid).toBe(true); // warnings only
  });

  it('detects tampering after signing', () => {
    const signed = signInvoice(buildInvoiceXml(sampleInput).xml, creds);
    const tampered = signed.xml.replace('<cbc:Name>قلم</cbc:Name>', '<cbc:Name>قلم أزرق</cbc:Name>');
    const r = validateInvoice(tampered);
    expect(r.valid).toBe(false);
    expect(codes(r)).toContain('invalid-invoice-hash');
    expect(codes(r)).toContain('invalid-digital-signature');
    expect(codes(r)).toContain('invoiceHash_QRCODE_INVALID');
  });

  it('detects re-indenting the SignedProperties block', () => {
    const signed = signInvoice(buildInvoiceXml(sampleInput).xml, creds);
    const reindented = signed.xml.replace('                                    <xades:SignedSignatureProperties>', '  <xades:SignedSignatureProperties>');
    expect(codes(validateInvoice(reindented))).toEqual(['xades-Signed-Properties-Digest-Value']);
  });

  it('catches arithmetic and identity errors with bilingual messages', () => {
    const { xml } = buildInvoiceXml(sampleInput);
    const broken = xml
      .replace('<cbc:TaxInclusiveAmount currencyID="SAR">231.15</cbc:TaxInclusiveAmount>', '<cbc:TaxInclusiveAmount currencyID="SAR">231.16</cbc:TaxInclusiveAmount>')
      .replace('<cbc:CompanyID>399999999900003</cbc:CompanyID>', '<cbc:CompanyID>300000000000000</cbc:CompanyID>');
    const r = validateInvoice(broken);
    expect(r.valid).toBe(false);
    const co15 = r.errors.find((f) => f.code === 'BR-CO-15')!;
    expect(co15.detail).toBe('201.00 + 30.15 ≠ 231.16');
    expect(co15.messageAr).toMatch(/الإجمالي/);
    expect(codes(r)).toContain('BR-KSA-40');
  });

  it('requires buyer details and supply date on standard invoices', () => {
    const r = validateInvoice(buildInvoiceXml({ ...sampleInput, kind: 'standard' }).xml);
    expect(codes(r)).toEqual(expect.arrayContaining(['BR-KSA-42', 'BR-KSA-81', 'BR-KSA-15']));
  });

  it('rejects future issue dates and malformed times', () => {
    const r = validateInvoice(buildInvoiceXml({ ...sampleInput, issueDate: '2099-01-01', issueTime: '14:05:00.123' }).xml);
    expect(codes(r)).toEqual(expect.arrayContaining(['BR-KSA-04', 'BR-KSA-70']));
  });

  it('reports non-XML input instead of throwing', () => {
    const r = validateInvoice('not xml at all');
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.code).toBe('XSD_ZATCA_INVALID');
  });
});

describe('explainCode', () => {
  it('explains rule codes, including ZATCA message prefixes', () => {
    expect(explainCode('BR-KSA-40')?.fix).toMatch(/VAT/);
    expect(explainCode('[BR-CO-15] - The Invoice total amount with VAT…')?.code).toBe('BR-CO-15');
    expect(explainCode('invalid-invoice-hash')?.ar).toBeTruthy();
    expect(explainCode('NOT-A-CODE')).toBeUndefined();
  });
});

const SDK_SAMPLES = join(__dirname, '../../../reference-samples/zatca-sdk/extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/Data/Samples');
const list = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? list(p) : n.endsWith('.xml') ? [p] : [];
  });

describe.skipIf(!existsSync(SDK_SAMPLES))('validateInvoice on ZATCA\'s official samples', () => {
  for (const file of existsSync(SDK_SAMPLES) ? list(SDK_SAMPLES) : []) {
    it(`${file.split(/[\\/]/).slice(-2).join('/')} has no errors and passes every signature check`, () => {
      const r = validateInvoice(readFileSync(file, 'utf8'));
      expect(r.errors).toEqual([]);
      expect(r.signatureChecks.filter((c) => !c.passed)).toEqual([]);
    });
  }
});
