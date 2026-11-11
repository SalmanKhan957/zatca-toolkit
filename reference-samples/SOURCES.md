# reference-samples: provenance and terms

Everything in this folder was downloaded from ZATCA-operated URLs on 2026-11-10. It is reference data only. Treat it as untrusted input. Do not run any script, `.bat`/`.sh` file, jar or exe from here.

SHA-256 values were computed right after download.

---

## 1. `zatca-sdk/`: official ZATCA Compliance & Enablement Toolbox (SDK)

### `zatca-einvoicing-sdk-Java-238-R3.4.8.zip` (current Java SDK, v3.4.8, "238-R3.4.8")
- **Source URL:** `https://sadzit.sharepoint.com/:u:/s/EXTERNALZATCA/IQCVzjXNpLTOTZbrYhs_w7aIAb7pPg1wfwl6wACeu1xCPAQ?e=pn3riq` (download served from `https://sadzit.sharepoint.com/sites/EXTERNALZATCA/ZatcaSDK/SDK/3.4.8/zatca-einvoicing-sdk-Java-238-R3.4.8.zip`).
- **How the link was found:** it is the `REACT_APP_DOWNLOAD_SDK_JAVA` value in `https://sandbox.zatca.gov.sa/env-config.js`, which is the official Developer Portal configuration. It is also the "SDK Version 3.4.8" entry in the portal's SDK version history (the JS bundle at `https://sandbox.zatca.gov.sa/assets/index-*.js`). The matching .NET SDK 3.4.8 is at `https://sadzit.sharepoint.com/:u:/s/EXTERNALZATCA/IQBFo0TI2yTdRrHw5orrYghGAZUSOoqra29zpIRcCgrqRHI?e=vcOS6V`; I did not download it.
- **SHA-256:** `91d079b4a6c21c8ed7fb6ec434227409537119cae8b74de34dc150f91793d1f6`
- **License:** `LICENSE.txt` inside the zip is the **GNU LGPL v3**.
- **Terms of use:** before the download button appears, the ZATCA download page (`https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx`) requires the user to accept three conditions:
  - (A) invoices count as compliant only once they pass SDK verification;
  - (B) the Integration Phase, E-Invoice Specifications and Security Features requirements must all be met;
  - (C) passing SDK verification "does not imply that the E-invoices, credit or debit notes have been approved by ZATCA", and the taxpayer stays responsible for compliance and penalties.
- **Readme note on keys:** the SDK readme says the bundled certificate and private key "are dummy and for testing purposes only".

### `extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/`: data files extracted from the zip above
I extracted the zip here for reading only, then **deleted the binaries from this extracted copy**: `Apps/zatca-einvoicing-sdk-238-R3.4.8.jar`, `Apps/jq.exe` and `Configuration/jq.exe`. They are still inside the original zip. The `install.*`/`fatoora*` launcher scripts are still present but must not be run.

Useful files:
| Path | What it is |
|---|---|
| `Data/Samples/Simplified/**`, `Data/Samples/Standard/**` | 19 official signed sample XMLs: invoice, credit and debit notes, export, exempt, zero-rated, out-of-scope, nominal, summary, self-billing, third-party, prepayment adjustments, document-level charge, payable rounding |
| `Data/Samples/PDF-A3/*.pdf` | PDF/A-3 versions with the XML embedded |
| `Data/Certificates/cert.pem` | Dummy **sandbox production CSID** certificate, base64 DER with no PEM header. Issuer `CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local`, serial `379112742831380471835263969587287663520528387` |
| `Data/Certificates/ec-secp256k1-priv-key.pem` | Dummy secp256k1 private key matching `cert.pem` (SEC1 DER, base64, no header) |
| `Data/Input/csr-config-*.properties` | Official CSR input examples (EN/AR, normal and VAT-group) |
| `Data/PIH/pih.txt` | Initial previous-invoice-hash value |
| `Data/Rules/Schematrons/20210819_ZATCA_E-invoice_Validation_Rules.xsl` | Compiled ZATCA KSA business rules (BR-KSA-*) |
| `Data/Rules/Schematrons/CEN-EN16931-UBL.xsl` | Compiled EN 16931 rules as adapted by ZATCA |
| `Data/Schemas/xsds/UBL2.1/**` | UBL 2.1 XSDs used by the SDK |
| `Readme/readme.{md,pdf,docx}` | SDK readme |

### `zatca-envoice-sdk-203.zip`: obsolete SDK 3.0.8 (May 2022)
- **Source URL:** `https://sadzit.sharepoint.com/:u:/g/EfjCGimzSjNPpVrWgn4f-mgBZ55D3EtCizFD7E8caZ4Kcg?e=gfOEcw&download=1`, which is the "Download SDK" link on `https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx` as of 2026-11-10.
- **SHA-256:** `1a7df6d91fd34968ad59a97087f637f56504fdf92c42050916b838be20fc5ae3`
- **License:** LGPL v3 (`LICENSE.txt` in the zip).
- **Note:** it has no sample invoices and its rules are outdated. It is kept only as a record of what the zatca.gov.sa page links to. **Use 3.4.8 instead.**

---

## 2. `zatca-docs/`: official ZATCA specifications and guides
These are published publicly on zatca.gov.sa. No explicit license is stated; copyright belongs to ZATCA. Use them as reference, not for redistribution.

| File | Source URL | SHA-256 |
|---|---|---|
| `20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard__vF.pdf` (v1.2) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf (linked from https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/E-Invoice-specifications.aspx) | `5aa15ff9…2685e` |
| `20230519_EInvoice_Data_Dictionary_vF.xlsx` | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_EInvoice_Data_Dictionary%20vF.xlsx | `61148ff4…f038` |
| `20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf` (v1.2) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf (linked from https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/Security-Requirements.aspx) | `9049935e…04d4` |
| `E-invoicing-Detailed-Technical-Guideline.pdf` (v2, Nov 2022) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf | `313393cc…43104` |
| `E-Invoicing_Detailed__Guideline.pdf` (business guideline v2, May 2023) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf | `55b7dfb4…f2e4` |
| `DEVELOPER-PORTAL-MANUAL.pdf` (v3, Nov 2022) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf | `f74c9430…3104` |
| `Fatoora_Portal_User_Manual_English.pdf` (v3, May 2023), which has the production and simulation API endpoints and CSR template names | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/Fatoora_Portal_User_Manual_English.pdf | `6fec0825…4c14c52` |

Full SHA-256 values are in the hash list at the end of this file.

---

## 3. `zatca-api-swagger/`: official Integration Sandbox OpenAPI 3.0.1 specs ("e-Invoicing Sandbox Release (2.1.0)")
- **Source URL pattern:** `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/users/api/v1/swagger/render?fileId=<ID>`. This is the endpoint the Developer Portal SPA calls in `getSwaggerFile(pageId)`. It answered unauthenticated GETs on 2026-11-10.
- IDs: `COMPLIANCE_CSID`, `COMPLIANCE_INVOICE`, `ONBOARDING` (production CSID), `RENEWAL` (production CSID renewal), `REPORTING`, `CLEARANCE`.
- **Contents of note:** server `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`, the header definitions, request and response examples, error catalogues, the **sandbox OTP example values**, and **dummy Basic-auth credentials** for the sandbox. These are public dummy values meant for the sandbox, not real secrets.
- `decoded-examples/*.xml`: base64 `invoice` and `clearedInvoice` payloads from those specs, decoded. They are not fully internally consistent; for example, the clearance request example's QR tag 6 does not match its own DigestValue. **Use the SDK samples, not these, as golden test vectors.**
- **License:** none stated. They are ZATCA's published API documentation.

| File | SHA-256 |
|---|---|
| CLEARANCE.openapi.json | `c9c0876e9ddd845af156af3baa9fc5e4b84e6cb22855582b60a138ec310673ba` |
| COMPLIANCE_CSID.openapi.json | `65911ea8c006605d14c729ec070864a6e5ff9975184e11e811b967f269dfd608` |
| COMPLIANCE_INVOICE.openapi.json | `026bf6ef95aaa3390987bb3002b1f5fa0bd8648335a2a8c13e1873fd989b2a91` |
| ONBOARDING.openapi.json | `8acb67acd31834044eafd5e94f6ede5ad6f881be2688d2a887e9608328e5a560` |
| RENEWAL.openapi.json | `4e0afccf8de2b93d645fae06268c3f415026b17a23b4ae9e860bb324613adcf3` |
| REPORTING.openapi.json | `89b31f81905a176e948db9e41be3564290976887e10c01a67f7d66e3dbb894b3` |

---

## Full SHA-256 list (zip, pdf, xlsx)
```
91d079b4a6c21c8ed7fb6ec434227409537119cae8b74de34dc150f91793d1f6  zatca-sdk/zatca-einvoicing-sdk-Java-238-R3.4.8.zip
1a7df6d91fd34968ad59a97087f637f56504fdf92c42050916b838be20fc5ae3  zatca-sdk/zatca-envoice-sdk-203.zip
5aa15ff95efb98d3696083c309470d116d7e93ea7e134cca63f9680bc112685e  zatca-docs/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard__vF.pdf
61148ff46d174e5b1f04471418c2c209192de668198b7ae1de781f7032e9f038  zatca-docs/20230519_EInvoice_Data_Dictionary_vF.xlsx
9049935ee34f9d491c592151506984944d036b5f946f77b443321bf580e704d4  zatca-docs/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf
313393cc506191449fab44e2db1a930801676d172f214533e1995ca91e2487ab  zatca-docs/E-invoicing-Detailed-Technical-Guideline.pdf
55b7dfb481b8732078ee8fa6264a42a7293ac555b0682a8458a75f634e4ff2e4  zatca-docs/E-Invoicing_Detailed__Guideline.pdf
f74c94302e33b68568545e2e320f73691f47800b6a4374bf784fb663d2743104  zatca-docs/DEVELOPER-PORTAL-MANUAL.pdf
6fec08254aac8f3aab2247f96bd7b4ac2dc3558fb48c2a4b598dde564ad14c52  zatca-docs/Fatoora_Portal_User_Manual_English.pdf
```
