import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ServerConfig, createServer } from '../src/server.js';

// Throwaway self-signed secp256k1 test credentials (not ZATCA-issued).
const KEY = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIMf3S32h0C3PnrC7DZzbnqTQotKkPJMFZgd6vIrwFT9ioAcGBSuBBAAK
oUQDQgAEaEYvG9CXp2gzPC3d1nJA1u5s03a0n9Ht1uAYv95hopzxdMxxIs4tevr+
L1ehXHJ+JO80GvObzpEE1J0QuQs2WQ==
-----END EC PRIVATE KEY-----`;
const CERT = `MIICEjCCAbigAwIBAgIUCOwXqyirj/xAf7tAjFbLxNuA8AUwCgYIKoZIzj0EAwIwYDELMAkGA1UEBhMCU0ExETAPBgNVBAoMCFRlc3QgT3JnMRYwFAYDVQQLDA1SaXlhZGggQnJhbmNoMSYwJAYDVQQDDB1UU1QtODg2NDMxMTQ1LTM5OTk5OTk5OTkwMDAwMzAeFw0yNjExMTAwMDA3MjdaFw0zNjExMDcwMDA3MjdaMGAxCzAJBgNVBAYTAlNBMREwDwYDVQQKDAhUZXN0IE9yZzEWMBQGA1UECwwNUml5YWRoIEJyYW5jaDEmMCQGA1UEAwwdVFNULTg4NjQzMTE0NS0zOTk5OTk5OTk5MDAwMDMwVjAQBgcqhkjOPQIBBgUrgQQACgNCAARoRi8b0JenaDM8Ld3WckDW7mzTdrSf0e3W4Bi/3mGinPF0zHEizi16+v4vV6Fccn4k7zQa85vOkQTUnRC5CzZZo1MwUTAdBgNVHQ4EFgQUELjshUaNHx0RvQCgxJj1YZEplSswHwYDVR0jBBgwFoAUELjshUaNHx0RvQCgxJj1YZEplSswDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAHAuFqxrDmJifczvYIbwWcJPMPckpJdoduP4WOR3l18wIhAJaRRybgb0gAFwaVHi6UwWRamvjUjbLw4rHW0TraInhc`;

const dir = mkdtempSync(join(tmpdir(), 'zatca-mcp-'));
const config: ServerConfig = {
  environment: 'sandbox',
  privateKey: KEY,
  certificate: CERT,
  stateFile: join(dir, 'state.json'),
  allowProduction: false,
  seller: {
    name: 'Test Org',
    vatNumber: '399999999900003',
    identification: { scheme: 'CRN', value: '1010010000' },
    address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' },
  },
};

const client = new Client({ name: 'test', version: '1.0.0' });
const textOf = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>)[0]!.text;

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(config).connect(a);
  await client.connect(b);
});

describe('zatca-toolkit MCP server', () => {
  it('lists its tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['compute_invoice_hash', 'create_invoice', 'decode_qr', 'explain_error', 'generate_csr', 'submit_invoice', 'validate_invoice'].sort(),
    );
  });

  it('creates signed invoices that chain ICV and PIH through the state file', async () => {
    const out1 = join(dir, 'inv1.xml');
    const r1 = await client.callTool({ name: 'create_invoice', arguments: { kind: 'simplified', number: 'A-1', lines: [{ name: 'Coffee', quantity: 2, unitPrice: '10' }], outputPath: out1 } });
    expect(r1.isError).toBeFalsy();
    expect(textOf(r1)).toMatch(/Signed simplified invoice A-1 \(ICV 1/);
    expect(textOf(r1)).toMatch(/Net 20.00 \+ VAT 3.00 = 23.00 SAR/);

    const state1 = JSON.parse(readFileSync(config.stateFile, 'utf8'));
    expect(state1.counter).toBe(1);

    const r2 = await client.callTool({ name: 'create_invoice', arguments: { kind: 'simplified', number: 'A-2', lines: [{ name: 'Tea', quantity: 1, unitPrice: '5' }] } });
    expect(textOf(r2)).toMatch(/ICV 2/);
    expect(textOf(r2)).toContain(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${state1.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>`);

    const v = await client.callTool({ name: 'validate_invoice', arguments: { path: out1 } });
    expect(textOf(v)).toMatch(/✅ No errors — simplified invoice, signed/);
    expect(textOf(v)).not.toMatch(/✗/);
  });

  it('decodes QR codes and explains errors bilingually', async () => {
    const qr = await client.callTool({ name: 'decode_qr', arguments: { qr: 'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==' } });
    expect(textOf(qr)).toMatch(/1\. Seller name \(12 bytes\): Bobs Records/);
    expect(textOf(qr)).toMatch(/Phase 1 QR/);

    const ex = await client.callTool({ name: 'explain_error', arguments: { error: '{"code":"BR-KSA-37","message":"[BR-KSA-37] - The seller address building number must contain 4 digits."}' } });
    expect(textOf(ex)).toMatch(/BR-KSA-37/);
    expect(textOf(ex)).toMatch(/رقم مبنى/);
  });

  it('writes the CSR private key to a file and never prints it', async () => {
    const keyPath = join(dir, 'egs-key.pem');
    const r = await client.callTool({
      name: 'generate_csr',
      arguments: {
        commonName: 'EGS1',
        solutionName: 'Demo',
        modelOrVersion: '1.0',
        deviceSerial: 'abc',
        vatNumber: '399999999900003',
        organizationUnit: 'Riyadh Branch',
        organizationName: 'Test Org',
        invoiceType: '1100',
        location: 'RRRD2929',
        industry: 'Software',
        keyOutputPath: keyPath,
      },
    });
    expect(textOf(r)).toMatch(/BEGIN CERTIFICATE REQUEST/);
    expect(textOf(r)).not.toMatch(/PRIVATE KEY-----\n/);
    expect(readFileSync(keyPath, 'utf8')).toMatch(/BEGIN EC PRIVATE KEY/);
    const again = await client.callTool({ name: 'generate_csr', arguments: { commonName: 'x', solutionName: 'x', modelOrVersion: 'x', deviceSerial: 'x', vatNumber: '399999999900003', organizationUnit: 'x', organizationName: 'x', invoiceType: '1100', location: 'x', industry: 'x', keyOutputPath: keyPath } });
    expect(again.isError).toBe(true);
  });

  it('refuses to submit without CSID credentials', async () => {
    const r = await client.callTool({ name: 'submit_invoice', arguments: { mode: 'report', xml: '<x/>' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ZATCA_CSID_SECRET/);
  });
});
