# zatca-toolkit

**Generate, sign, validate and submit Saudi ZATCA (Fatoora) Phase 2 e-invoices in TypeScript, plus an MCP server so AI assistants can do it too.**

Pure TypeScript: no OpenSSL, no Java, no temp files. Runs in Node, browsers and edge workers. MIT licensed.

> ZATCA's Wave 25 brings every VAT-registered business with revenue above SAR 187,500 into Phase 2 integration by **1 February 2027**. This library is for the developers wiring that up.

## Why another ZATCA library?

Because ZATCA's byte-level rules are unforgiving, and most open-source implementations get some of them wrong. This one is **verified, not hoped**:

- ✅ **Reproduces the invoice hash, signature, certificate digest, SignedProperties digest and every QR tag of all 19 official signed samples** in ZATCA SDK 3.4.8, byte for byte.
- ✅ **Re-signing each official sample yields ZATCA's own invoice hash.**
- ✅ **CSR is byte-identical** (CertificationRequestInfo) to the sample CSR in ZATCA's official sandbox API spec.
- ✅ **Passed the live ZATCA developer sandbox end to end** (2026-11-10): compliance CSID → all 6 compliance documents (standard/simplified × invoice/credit/debit) **PASS with zero warnings** → production CSID → simplified invoice **REPORTED** → standard invoice **CLEARED**.
- ✅ 186 automated tests, including the W3C canonicalization test vectors.

## The traps it handles (that other libraries trip on)

| Trap | What ZATCA actually does |
|---|---|
| Invoice hash | C14N of the document with `UBLExtensions`, `cac:Signature` and the QR reference removed, **keeping the whitespace around them**. Dropping it gives a wrong hash. |
| First PIH | The *only* base64-of-hex value (88 chars); every later PIH is base64 of raw bytes (44 chars). |
| What gets signed | ECDSA secp256k1 over the 32 raw hash bytes, **not** a standard XMLDSig over `SignedInfo`. |
| Certificate digest | `base64(hex(sha256(base64 certificate text)))`, not a hash of the DER bytes. |
| SignedProperties digest | Hash of the element **as indented in the document** with `xmlns:xades` / `xmlns:ds` injected; base64 of the hex digest. Not C14N. |
| QR lengths | ZATCA parses BER-TLV: values of 128+ bytes need the long form `0x81 LL`. Long Arabic seller names break libraries that write one byte. |
| QR tag 4 | `PayableAmount` when there is a prepayment or rounding adjustment, else `TaxInclusiveAmount`. |
| Signature insertion | Must not add whitespace inside the hashed region; the signer re-hashes the final document and refuses to return a mismatch. |
| CSR | VAT number in SAN `UID`, invoice type in `title`, UTF8String template name that differs per environment, sent as base64 of the PEM text. |
| Money | Exact decimal arithmetic, half-up rounding, VAT computed per category total (not a sum of rounded line VATs). |

## Install

```bash
npm install zatca-toolkit
```

## Quick start

```ts
import { createSignedInvoice, validateInvoice, FatooraClient } from 'zatca-toolkit';

const signed = createSignedInvoice(
  {
    kind: 'simplified',              // B2C; use 'standard' for B2B
    number: 'INV-0001',
    issueDate: '2026-11-10',
    issueTime: '14:05:00',
    counter: 1,                      // ICV: strictly increasing per device
    // previousInvoiceHash: omit for the first invoice
    seller: {
      name: 'شركة المثال | Example Co',
      vatNumber: '399999999900003',
      identification: { scheme: 'CRN', value: '1010010000' },
      address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' },
    },
    lines: [{ name: 'Consulting hour', quantity: 2, unitPrice: '250.00', vat: { category: 'S' } }],
  },
  { privateKey: process.env.ZATCA_PRIVATE_KEY!, certificate: process.env.ZATCA_CERTIFICATE! },
);

signed.xml;          // signed UBL XML
signed.qr;           // base64 QR payload, render it as the QR image
signed.invoiceHash;  // store it: it is the next invoice's previousInvoiceHash

validateInvoice(signed.xml); // offline pre-check with English + Arabic messages

const zatca = new FatooraClient({ environment: 'sandbox' });
await zatca.reportInvoice({ binarySecurityToken, secret }, signed);
```

### Onboarding (getting a CSID)

```ts
import { generateKeyPair, generateCsr, egsSerialNumber, FatooraClient, SANDBOX_OTP } from 'zatca-toolkit';

const { privateKey } = generateKeyPair();
const csr = generateCsr({
  commonName: 'EGS1-399999999900003',
  serialNumber: egsSerialNumber('MyPOS', '1.0', 'device-123'),
  vatNumber: '399999999900003',
  organizationUnit: 'Riyadh Branch',
  organizationName: 'Example Co',
  invoiceType: '1100',               // standard + simplified
  location: 'RRRD2929',
  industry: 'Retail',
  environment: 'sandbox',            // sandbox | simulation | production
}, privateKey);

const zatca = new FatooraClient({ environment: 'sandbox' });
const ccsid = await zatca.requestComplianceCsid(csr.apiValue, SANDBOX_OTP);
// sign one invoice, credit note and debit note per declared type with ccsid.binarySecurityToken,
// send each with zatca.checkCompliance(ccsid, doc), then:
const pcsid = await zatca.requestProductionCsid(ccsid, ccsid.requestID);
```

`scripts/sandbox-e2e.ts` runs the whole flow against the live sandbox: `npx tsx packages/core/scripts/sandbox-e2e.ts`.

## API overview

| Function | Purpose |
|---|---|
| `buildInvoiceXml(input)` | Unsigned UBL 2.1 XML (invoice, credit note, debit note) with computed totals |
| `signInvoice(xml, credentials)` | Hash, ECDSA, XAdES, QR; inserted without touching hashed bytes |
| `createSignedInvoice(input, credentials)` | Both of the above |
| `validateInvoice(xml)` | Offline checks: common BR-KSA / EN 16931 rules, totals, hash, signature, digests, QR |
| `explainCode(code)` | Plain-language explanation (EN + AR) and fix for rule and API error codes |
| `computeInvoiceHash(xml)` | The value ZATCA expects in `invoiceHash`, `DigestValue`, QR tag 6 and the next PIH |
| `encodeQr` / `decodeQr` | BER-TLV QR payloads; `decodeQr` warns about non-BER lengths |
| `generateKeyPair`, `generateCsr` | secp256k1 keys and ZATCA-shaped CSRs |
| `FatooraClient` | Compliance CSID, compliance checks, production CSID, renewal, reporting, clearance |
| `computeTotals`, `Decimal` | Exact VAT arithmetic |

The Fatoora API does not allow browser CORS, so call `FatooraClient` from a server.

## MCP server (Claude, Cursor, any MCP client)

`zatca-toolkit-mcp` exposes the toolkit to AI assistants: `create_invoice`, `validate_invoice`, `decode_qr`, `explain_error`, `compute_invoice_hash`, `generate_csr` and `submit_invoice`.

```json
{
  "mcpServers": {
    "zatca": {
      "command": "npx",
      "args": ["-y", "zatca-toolkit-mcp"],
      "env": {
        "ZATCA_ENV": "sandbox",
        "ZATCA_PRIVATE_KEY_FILE": "/path/to/egs-key.pem",
        "ZATCA_CERTIFICATE": "<binarySecurityToken>",
        "ZATCA_CSID_SECRET": "<secret>",
        "ZATCA_SELLER_FILE": "/path/to/seller.json"
      }
    }
  }
}
```

Then ask: *"Create a simplified invoice for 2 hours of consulting at 250 SAR"*, *"Why does ZATCA say BR-KSA-37?"*, or *"Validate ./invoice.xml"*.

- The ICV counter and previous-invoice hash are kept in `~/.zatca-toolkit/state.json` (override with `ZATCA_STATE_FILE`).
- Private keys are written to files and never printed.
- Production submissions are refused unless `ZATCA_ALLOW_PRODUCTION=1`.

## Browser playground

`packages/demo` is a single-page playground that builds, signs, validates and decodes invoices entirely client-side (it shows the library running in a browser). It signs with a throwaway test certificate generated in the page.

```bash
npm run build -w zatca-toolkit-demo         # -> packages/demo/dist/index.html (one self-contained file)
npx wrangler pages deploy packages/demo/dist --project-name zatca-toolkit   # free Cloudflare Pages hosting
```

## Running the tests

```bash
npm install
npm test
```

The conformance suite runs against ZATCA's official SDK samples when they are present. They are LGPL-licensed and not redistributed here; see `reference-samples/SOURCES.md` for where to download them. Without them, the remaining tests still run.

## Scope and limitations

- `validateInvoice` checks the rules developers break most often. It is a pre-flight check, **not** ZATCA's validator: it does not run all 240+ schematron assertions or the XSD.
- Document-level charges, prepayment invoices (386) and non-SAR currencies with full prepayment handling are not built by `buildInvoiceXml` yet. Signing and validating such documents works.
- `docs/zatca-spec-notes.md` records every byte-level decision with its source, and lists what is still unverified.

## Disclaimer

Not affiliated with, endorsed by, or approved by ZATCA. Passing the sandbox or this library's checks does not mean ZATCA has approved your invoices; taxpayers remain responsible for compliance.

## License

MIT
