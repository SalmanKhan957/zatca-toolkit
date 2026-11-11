import { describe, expect, it } from 'vitest';
import { parseDer } from '../src/asn1.js';
import { type CsrInput, egsSerialNumber, generateCsr, validateCsrInput } from '../src/csr.js';
import { base64ToBytes, bytesToHex, pemToDer, utf8Decode } from '../src/encoding.js';
import { parsePrivateKey, verifyEcdsa } from '../src/keys.js';

/** ZATCA's dummy sandbox key (published in the SDK and the sandbox OpenAPI spec). */
const DUMMY_KEY =
  'MHQCAQEEIL14JV+5nr/sE8Sppaf2IySovrhVBtt8+yz+g4NRKyz8oAcGBSuBBAAKoUQDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==';

/** The sample CSR in ZATCA's official COMPLIANCE_CSID OpenAPI spec (sandbox release 2.1.0). */
const OFFICIAL_SAMPLE_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICFTCCAbwCAQAwdTELMAkGA1UEBhMCU0ExFjAUBgNVBAsMDVJpeWFkaCBCcmFu
Y2gxJjAkBgNVBAoMHU1heGltdW0gU3BlZWQgVGVjaCBTdXBwbHkgTFREMSYwJAYD
VQQDDB1UU1QtODg2NDMxMTQ1LTM5OTk5OTk5OTkwMDAwMzBWMBAGByqGSM49AgEG
BSuBBAAKA0IABKFgimtEmvRSBK0zr9LgJAtVSCl8VPZz6cdr5X+MoTHo8vHNNlyW
5Q6u7T8naPJqtGoTjJjaPIMJ4u17dSk/VHiggecwgeQGCSqGSIb3DQEJDjGB1jCB
0zAhBgkrBgEEAYI3FAIEFAwSWkFUQ0EtQ29kZS1TaWduaW5nMIGtBgNVHREEgaUw
gaKkgZ8wgZwxOzA5BgNVBAQMMjEtVFNUfDItVFNUfDMtZWQyMmYxZDgtZTZhMi0x
MTE4LTliNTgtZDlhOGYxMWU0NDVmMR8wHQYKCZImiZPyLGQBAQwPMzk5OTk5OTk5
OTAwMDAzMQ0wCwYDVQQMDAQxMTAwMREwDwYDVQQaDAhSUlJEMjkyOTEaMBgGA1UE
DwwRU3VwcGx5IGFjdGl2aXRpZXMwCgYIKoZIzj0EAwIDRwAwRAIgSGT0qBBzLRG8
IKOfzR5/O9KEbpp8mg7WejRYefCY7uQCIFZ0tSmz302nf/tj4WaqmV07MjeUdVuo
RIrJKbLmQfS7
-----END CERTIFICATE REQUEST-----`;

const OFFICIAL_INPUT: CsrInput = {
  commonName: 'TST-886431145-399999999900003',
  serialNumber: egsSerialNumber('TST', 'TST', 'ed22f1d8-e6a2-1118-9b58-d9a8f11e445f'),
  vatNumber: '399999999900003',
  organizationUnit: 'Riyadh Branch',
  organizationName: 'Maximum Speed Tech Supply LTD',
  invoiceType: '1100',
  location: 'RRRD2929',
  industry: 'Supply activities',
  environment: 'production', // the official sample carries ZATCA-Code-Signing
};

describe('generateCsr', () => {
  it('produces a CertificationRequestInfo byte-identical to ZATCA\'s official sample CSR', () => {
    const csr = generateCsr(OFFICIAL_INPUT, parsePrivateKey(DUMMY_KEY));
    const ours = parseDer(csr.der).children[0]!.der;
    const theirs = parseDer(pemToDer(OFFICIAL_SAMPLE_CSR)).children[0]!.der;
    expect(bytesToHex(ours)).toBe(bytesToHex(theirs));
  });

  it('is correctly self-signed (proof of possession)', () => {
    const key = parsePrivateKey(DUMMY_KEY);
    const csr = generateCsr(OFFICIAL_INPUT, key);
    const root = parseDer(csr.der);
    const info = root.children[0]!.der;
    const sig = root.children[2]!.content.slice(1);
    const spkiPoint = root.children[0]!.children[2]!.children[1]!.content.slice(1);
    expect(verifyEcdsa(sig, info, spkiPoint)).toBe(true);
  });

  it('encodes the API value as base64 of the PEM text', () => {
    const csr = generateCsr({ ...OFFICIAL_INPUT, environment: 'sandbox' }, parsePrivateKey(DUMMY_KEY));
    expect(utf8Decode(base64ToBytes(csr.apiValue))).toBe(csr.pem);
    expect(csr.pem.startsWith('-----BEGIN CERTIFICATE REQUEST-----\n')).toBe(true);
    expect(new TextDecoder().decode(csr.der)).toContain('TSTZATCA-Code-Signing'); // non-fatal decode of binary DER
  });

  it('explains invalid input', () => {
    const problems = validateCsrInput({ ...OFFICIAL_INPUT, vatNumber: '123', invoiceType: '1111', serialNumber: 'abc' });
    expect(problems).toHaveLength(3);
    expect(validateCsrInput({ ...OFFICIAL_INPUT, vatNumber: '399999999910003' })[0]).toMatch(/VAT group/);
  });
});
