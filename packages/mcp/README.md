# zatca-toolkit-mcp

An MCP server that lets Claude, Cursor or any MCP client **create, sign, validate and explain Saudi ZATCA (Fatoora) e-invoices**.

It is built on [`zatca-toolkit`](https://www.npmjs.com/package/zatca-toolkit), whose output matches ZATCA's official SDK samples byte for byte and passed the live ZATCA sandbox end to end.

## Tools

| Tool | What it does |
|---|---|
| `create_invoice` | Build (and sign, if credentials are set) an invoice, credit note or debit note with exact VAT totals; keeps the ICV/PIH chain for you |
| `validate_invoice` | Offline pre-check: common BR-KSA / EN 16931 rules, totals, hash, signature, XAdES digests, every QR tag; English + Arabic explanations |
| `decode_qr` | Decode a QR payload; flags non-BER lengths ZATCA rejects |
| `explain_error` | Paste a ZATCA error code or API response and get the cause and fix |
| `compute_invoice_hash` | Debug `invalid-invoice-hash` |
| `generate_csr` | New secp256k1 key (saved to a file, never shown) + ZATCA CSR |
| `submit_invoice` | Report, clear or run compliance checks via the Fatoora API (sandbox by default) |

## Setup

```json
{
  "mcpServers": {
    "zatca": {
      "command": "npx",
      "args": ["-y", "zatca-toolkit-mcp"],
      "env": {
        "ZATCA_ENV": "sandbox",
        "ZATCA_PRIVATE_KEY_FILE": "/path/to/egs-key.pem",
        "ZATCA_CERTIFICATE": "<binarySecurityToken from ZATCA>",
        "ZATCA_CSID_SECRET": "<secret from ZATCA>",
        "ZATCA_SELLER_FILE": "/path/to/seller.json"
      }
    }
  }
}
```

All variables are optional. Without credentials you can still validate, decode, explain and create unsigned invoices.

| Variable | Meaning |
|---|---|
| `ZATCA_ENV` | `sandbox` (default), `simulation` or `production` |
| `ZATCA_PRIVATE_KEY` / `_FILE` | secp256k1 key (PEM or base64) |
| `ZATCA_CERTIFICATE` / `_FILE` | CSID certificate or the `binarySecurityToken` |
| `ZATCA_CSID_SECRET` / `_FILE` | CSID secret, needed to submit |
| `ZATCA_SELLER` / `_FILE` | Seller JSON: `{ name, vatNumber, identification: { scheme, value }, address: {...} }` |
| `ZATCA_STATE_FILE` | Where the ICV counter and last hash are kept (default `~/.zatca-toolkit/state.json`) |
| `ZATCA_ALLOW_PRODUCTION` | Must be `1` to submit to production |

Not affiliated with or endorsed by ZATCA. MIT licensed.
