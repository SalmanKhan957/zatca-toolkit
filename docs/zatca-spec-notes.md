# ZATCA E-Invoicing Phase 2 (Fatoora integration phase): implementation spec notes

Compiled on 2026-11-10 for a TypeScript library that handles UBL 2.1 XML generation, invoice hashing, XAdES/ECDSA-secp256k1 signing, QR TLV, CSR generation and the Fatoora API client.

## How to read this document

Each statement carries an evidence label:

| Label | Meaning |
|---|---|
| **[OFFICIAL]** | Stated in a ZATCA-published document or API spec. The source is cited. |
| **[SDK-VERIFIED]** | I reproduced it byte-for-byte on 2026-11-10 against the official signed samples in ZATCA SDK 3.4.8, using my own scripts (Python + lxml + OpenSSL 3.2) and running nothing from the SDK. This is the strongest evidence available, because these samples pass ZATCA's validator. |
| **[SDK]** | Read directly from SDK 3.4.8 artefacts: schematron XSL, templates or sample files. |
| **[COMMUNITY]** | Community libraries or forum posts. Treat as evidence, not authority. |
| **UNVERIFIED** | I could not confirm it. Do not rely on it without testing against the sandbox or simulation. |

Where official documents contradict the SDK, **section 12** lists every conflict I found. The rule I applied throughout: *the SDK samples are what ZATCA's validator accepts, so the SDK wins on byte-level behaviour.*

### Primary sources (local copies are in `../reference-samples/`; see `SOURCES.md`)

| Key | Document | URL |
|---|---|---|
| S-SDK | ZATCA E-Invoicing SDK (Java) 238-R3.4.8: samples, schematrons, XSDs, dummy cert and key, CSR configs | https://sadzit.sharepoint.com/:u:/s/EXTERNALZATCA/IQCVzjXNpLTOTZbrYhs_w7aIAb7pPg1wfwl6wACeu1xCPAQ?e=pn3riq (linked from https://sandbox.zatca.gov.sa → Download SDK) |
| S-XML | Electronic Invoice XML Implementation Standard v1.2 (2023-05-19) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf |
| S-DD | Electronic Invoice Data Dictionary (2023-05-19) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_EInvoice_Data_Dictionary%20vF.xlsx |
| S-SEC | Security Features Implementation Standards v1.2 (2023-05-19) | https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf |
| S-DTG | E-invoicing Detailed **Technical** Guideline v2 (Nov 2022) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf |
| S-BIZ | Detailed Guidelines for E-Invoicing v2 (May 2023, business) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-Invoicing_Detailed__Guideline.pdf |
| S-DPM | Developer Portal Manual v3 (Nov 2022) | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf |
| S-FPM | FATOORA Portal User Manual v3 (May 2023): API endpoints and CSR template names | https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/Fatoora_Portal_User_Manual_English.pdf |
| S-OAS | Official Integration Sandbox OpenAPI specs ("e-Invoicing Sandbox Release (2.1.0)"), one per API | `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/users/api/v1/swagger/render?fileId={COMPLIANCE_CSID,COMPLIANCE_INVOICE,ONBOARDING,RENEWAL,REPORTING,CLEARANCE}` |
| S-PORTAL | Developer Portal SPA config, including SDK links and version history | https://sandbox.zatca.gov.sa/env-config.js |
| S-W25 | ZATCA news: Wave 25 | https://zatca.gov.sa/en/MediaCenter/News/Pages/Wave25-E-invoicing.aspx |
| S-FORUM | ZATCA developer community forum (linked from the Developer Portal) | https://zatca1.discourse.group |

---

## 0. Byte-level cheat sheet (the decisions that make or break acceptance)

All items are [SDK-VERIFIED] unless marked otherwise. Section 11 has the golden test vectors.

1. **Root element is always `<Invoice>`**, in namespace `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`, for invoices, credit notes and debit notes alike. The document kind comes from `cbc:InvoiceTypeCode` (388/381/383/386) plus its 7-character `@name`.
2. **Invoice hash** works like this:
   - parse the final XML;
   - remove exactly three element nodes: `/Invoice/ext:UBLExtensions`, `/Invoice/cac:Signature`, and `/Invoice/cac:AdditionalDocumentReference[cbc:ID='QR']`. **Keep the whitespace text nodes around them.**
   - canonicalize with C14N 1.1 (inclusive; equivalent to C14N 1.0 for these documents), without the XML declaration;
   - compute SHA-256;
   - **base64 of the 32 raw digest bytes** (a 44-character string).
3. **First PIH** = `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==`. That is base64 of the *hex string* of SHA-256("0"), 88 characters. Every later PIH is the previous document's invoice hash: base64 of raw bytes, 44 characters.
4. **SignatureValue** = base64 of the **DER** ECDSA(secp256k1) signature produced by *SHA256withECDSA over the 32 raw invoice-hash bytes*. In effect the curve signs SHA256(SHA256(c14n)). It is **not** a standard XMLDSig signature over `ds:SignedInfo`.
5. **CertDigest** (`xades:CertDigest/ds:DigestValue`) = base64 of the **lowercase hex string** of SHA-256 computed over the **base64 certificate text** (the ASCII "MIID…" string, no PEM header). It is *not* computed over the DER bytes.
6. **SignedProperties digest** = base64 of the **lowercase hex string** of SHA-256 over the exact `<xades:SignedProperties …>…</xades:SignedProperties>` text:
   - with the same whitespace and indentation as in the emitted document (LF line endings);
   - with `xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"` inserted as the first attribute of `xades:SignedProperties`;
   - with `xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` inserted as the first attribute of **every** `ds:*` element inside it;
   - with empty elements left self-closing (`<ds:DigestMethod …/>`). This is not C14N output.
7. `X509IssuerName` = RFC 2253 order (most specific first) joined with **", "**, e.g. `CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local`. `X509SerialNumber` = the certificate serial as a **decimal** integer.
8. **QR** is BER-TLV with a 1-byte tag. The length is 1 byte when the value is under 128 bytes; at 128 bytes or more it uses BER long form (`0x81 LL` or `0x82 HH LL`). The SDK uses the payneteasy `BerTlvBuilder`/`BerTlvParser`; see §5.1. The long-form rule is [SDK], inferred from that library; no SDK sample exceeds 127 bytes, so it is not sample-verified.
   - tags 1–5 are the UTF-8 bytes of the literal XML text values;
   - tag 6 is the **base64 invoice-hash string** (44 bytes);
   - tag 7 is the **base64 SignatureValue string**;
   - tag 8 is the **raw DER SubjectPublicKeyInfo** (88 bytes for secp256k1);
   - tag 9 is the **raw DER ECDSA signature value of the certificate** (the CA's signature). Tag 9 appears on simplified documents only.
   - The whole byte string is then base64-encoded.
9. **API payload**: `{"invoiceHash": <b64 raw hash>, "uuid": <cbc:UUID>, "invoice": <base64 of the full XML file bytes>}`, sent with headers `Accept-Version: V2` and `Authorization: Basic base64(binarySecurityToken + ":" + secret)`. The token is used exactly as returned; it is itself base64 of the base64 DER certificate.
10. **CSR**:
    - secp256k1 key, ecdsa-with-SHA256;
    - subject is C, OU, O, CN;
    - SAN dirName holds `SN`=EGS serial "1-…|2-…|3-…", `UID`=VAT number, `title`=invoice-type "1100", `registeredAddress`, `businessCategory`;
    - extension `1.3.6.1.4.1.311.20.2` = UTF8String template name;
    - it is submitted as **base64 of the PEM text**.

---

## 1. Document types and codes

### 1.1 Invoice type code (BT-3), `cbc:InvoiceTypeCode`
[OFFICIAL] S-XML §11.2.1. [SDK] BR-KSA-05 accepts exactly `388 383 381 386`.

| Code | Document | Notes |
|---|---|---|
| 388 | Tax invoice (standard, subtype 01) or simplified tax invoice (subtype 02) | |
| 381 | Credit note | Uses the UBL `Invoice` root, not `CreditNote` |
| 383 | Debit note | |
| 386 | Prepayment (advance payment) invoice | Standard or simplified, depending on the subtype |

### 1.2 Invoice transaction code (KSA-2), the `@name` attribute
[OFFICIAL] S-XML §11.2.1. [SDK] BR-KSA-06 (error).

Structure `NNPNESB`, 7 characters, each position `0`/`1` except NN:

| Pos | Meaning | Notes |
|---|---|---|
| 1–2 | `01` = tax invoice (standard, B2B, **clearance**); `02` = simplified tax invoice (B2C, **reporting**) | Credit and debit notes take the subtype of the invoice they amend (S-XML §5.2) |
| 3 | Third-party invoice | |
| 4 | Nominal supply | |
| 5 | Export | Self-billing is not allowed on exports (BR-KSA-07, error). Since SDK 3.4.6 simplified exports are allowed (BR-KSA-31 amended). |
| 6 | Summary invoice | Simplified summary invoices require buyer name (BR-KSA-71) and supply date + supply end date (BR-KSA-72) |
| 7 | Self-billed | Not allowed on simplified documents (BR-KSA-31, error) |
| 8 | *Continuous supply* (added SDK 3.4.3) | [SDK] BR-KSA-06 in 3.4.8 accepts length 7, 8 or 9 |
| 9 | *B2G* (added SDK 3.4.3) | `1` makes `cac:ContractDocumentReference/cbc:ID` mandatory (BR-KSA-92, error) |

Positions 8–9 are new. Whether the **production** platform already accepts 8- or 9-character values is **UNVERIFIED**; emit 7 characters unless you need those flags. BR-KSA-F-06-C40 still says the minimum is 7.

Values seen in the official SDK samples [SDK]:

| Value | Sample |
|---|---|
| `0100000` | Standard |
| `0200000` | Simplified |
| `0201000` | Simplified nominal |
| `0100100` | Export |
| `0100010` | Summary |
| `0100001` | Self-billing |
| `0110000` | Third party |

### 1.3 Credit and debit note requirements
- `cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID` (BT-25) is mandatory for 381/383. This is BR-KSA-56 (warning in 3.4.8; the SDK 3.2.4 notes say it is "enforced" with the parent tag), with a length of 1–5000 characters (BR-KSA-F-06-C22, **error**). Free text is allowed; a range of invoice numbers is acceptable per S-BIZ §4.3. [OFFICIAL]/[SDK]
- The reason for issuing goes in `cac:PaymentMeans/cbc:InstructionNote` (KSA-10). It is mandatory for 381/383 (BR-KSA-17, **error**), 1–1000 characters. A `cac:PaymentMeans` element therefore must exist, and in UBL it requires `cbc:PaymentMeansCode`. [OFFICIAL]/[SDK]
- Amounts stay **positive**. The type code expresses the direction (BR-KSA-F-04, error: "All the document amounts and quantities must be positive"). [SDK]
- SDK sample reasons: "In case of goods or services refund | عند ترجيع السلع أو الخدمات" for credit notes; "Amendment of the supply value which is pre-agreed upon between the supplier and consumer | …" for debit notes. [SDK]
- Compliance checks expect a credit note and a debit note for each invoice subtype the EGS declares (§7.4).

### 1.4 Prepayment (advance payment)
[OFFICIAL] S-XML §9.5. [SDK] BR-KSA-73..82, sample `Standard/Invoice/Advance Payment adjustments*.xml`.

- The advance itself is invoiced with `InvoiceTypeCode` **386**.
- The final invoice that deducts it carries:
  - `cac:LegalMonetaryTotal/cbc:PrepaidAmount` (BT-113) = Σ(KSA-31 + KSA-32);
  - one extra `cac:InvoiceLine` per prepayment, in which:
    - `cbc:InvoicedQuantity`, `cbc:LineExtensionAmount`, `cac:Price/cbc:PriceAmount`, line `TaxAmount` and `RoundingAmount` are all **0.00** (BR-KSA-82, error);
    - `cac:DocumentReference` holds `cbc:ID` (prepayment invoice number), `cbc:IssueDate`, `cbc:IssueTime` and `cbc:DocumentTypeCode`=`386` (BR-KSA-74, error);
    - `cac:TaxTotal/cac:TaxSubtotal` holds the prepaid taxable amount (KSA-31), tax (KSA-32), category (KSA-33) and rate (KSA-34).
- Exempt, zero-rated and out-of-scope prepayment categories need reason codes (BR-KSA-93..96, BR-KSA-CL-07).

---

## 2. UBL XML structure

### 2.1 Namespaces
[SDK-VERIFIED] from the SDK samples and the SDK's internal `xml/ubl.xml` template.

| Prefix | URI | Declared where (SDK) |
|---|---|---|
| (default) | `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2` | root |
| `cac` | `urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2` | root |
| `cbc` | `urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2` | root |
| `ext` | `urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2` | root |
| `sig` | `urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2` | `sig:UBLDocumentSignatures` |
| `sac` | `urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2` | `sig:UBLDocumentSignatures` |
| `sbc` | `urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2` | `sig:UBLDocumentSignatures` |
| `ds` | `http://www.w3.org/2000/09/xmldsig#` | `ds:Signature` |
| `xades` | `http://uri.etsi.org/01903/v1.3.2#` | `xades:QualifyingProperties` |

The SDK samples declare exactly four namespaces on the root, in this order: default, cac, cbc, ext.

Namespace declarations on the root are part of the canonicalized hash input. That is harmless as long as you hash the document you send, but do not add or remove root namespace declarations after hashing.

S-DD (KSA-15) mentions `xmlns:xades="urn:oasis:names:specification:ubl:schema:xsd:XAdESv141-2"`. The SDK uses `http://uri.etsi.org/01903/v1.3.2#`. Use the SDK value.

### 2.2 Root children, in mandatory order
[SDK] The order comes from the UBL 2.1 XSD `InvoiceType` sequence (SDK `UBL-Invoice-2.1.xsd`), filtered to what ZATCA uses. Status follows S-DD: M = mandatory, C = conditional, O = optional. "Std" means tax invoice and its notes; "Simp" means simplified.

| # | Element | Std | Simp | Notes |
|---|---|---|---|---|
| 1 | `ext:UBLExtensions` | O | **M** | Cryptographic stamp (§4). Simplified documents must be signed by the EGS (BR-KSA-60). Standard documents may be signed; ZATCA stamps them at clearance (S-DTG §4.3.2). |
| 2 | `cbc:ProfileID` | M | M | Literal `reporting:1.0` (BR-KSA-EN16931-01, error) |
| 3 | `cbc:ID` | M | M | Invoice number (BT-1), 1–127 characters |
| 4 | `cbc:UUID` | M | M | KSA-1; letters, digits and dashes only (BR-KSA-03, error). Use a v4 UUID. |
| 5 | `cbc:IssueDate` | M | M | `YYYY-MM-DD`, no timezone (BR-KSA-F-01); not in the future (BR-KSA-04, error) |
| 6 | `cbc:IssueTime` | M | M | `HH:mm:ss` (local KSA time) or `HH:mm:ssZ` (UTC) (BR-KSA-70, error) |
| 7 | `cbc:InvoiceTypeCode @name` | M | M | §1 |
| 8 | `cbc:Note` | O | O | BT-22, ≤1000 characters; SDK sample uses `languageID="ar"` |
| 9 | `cbc:DocumentCurrencyCode` | M | M | ISO 4217 (BR-KSA-CL-01) |
| 10 | `cbc:TaxCurrencyCode` | M | M | Must exist (BR-KSA-68, error) and must be `SAR` (BR-KSA-EN16931-02, error) |
| 11 | `cac:OrderReference/cbc:ID` | O | O | BT-13 |
| 12 | `cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID` | C | C | Mandatory for 381/383 |
| 13 | `cac:ContractDocumentReference/cbc:ID` | O/C | O | BT-12; mandatory for B2G (KSA-2 position 9) |
| 14 | `cac:AdditionalDocumentReference` (**ICV**) | M | M | `<cbc:ID>ICV</cbc:ID><cbc:UUID>{counter}</cbc:UUID>`; digits only (BR-KSA-33/34, error) |
| 15 | `cac:AdditionalDocumentReference` (**PIH**) | M | M | `<cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">{PIH}</…></cac:Attachment>` |
| 16 | `cac:AdditionalDocumentReference` (**QR**) | O | **M** | Same shape as PIH with `cbc:ID` = `QR`; base64 TLV, ≤1000 characters (BR-CL-KSA-14) |
| 17 | `cac:Signature` | C | M | `<cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID><cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>` (BR-KSA-29/30). Present when UBLExtensions is present. |
| 18 | `cac:AccountingSupplierParty` | M | M | §2.3 |
| 19 | `cac:AccountingCustomerParty` | M | M (may be empty) | §2.4. The simplified sample uses an empty `<cac:AccountingCustomerParty>\n    </cac:AccountingCustomerParty>`. |
| 20 | `cac:Delivery` | C | C | `cbc:ActualDeliveryDate` (KSA-5) is required on standard 388 (BR-KSA-15, warning). `cbc:LatestDeliveryDate` (KSA-24) must be ≥ KSA-5 (BR-KSA-35/36). |
| 21 | `cac:PaymentMeans` | O | O | `cbc:PaymentMeansCode` (BT-81, UNTDID 4461), then `cbc:InstructionNote` (KSA-10, notes only), then `cac:PayeeFinancialAccount/cbc:ID` (BT-84) / `cbc:PaymentNote` (KSA-22) |
| 22 | `cac:AllowanceCharge` (0..n) | C | C | Document-level allowances and charges (§2.6) |
| 23 | `cac:TaxExchangeRate` | O | O | KSA-36..39 (`cbc:SourceCurrencyCode` = BT-5, `cbc:TargetCurrencyCode` = BT-6, `cbc:CalculationRate` ≤14 digits) (BR-KSA-87..90) |
| 24 | `cac:TaxTotal` **#1** (no subtotals) | M | M | §2.7 |
| 25 | `cac:TaxTotal` **#2** (with `cac:TaxSubtotal`) | M | M | §2.7 |
| 26 | `cac:LegalMonetaryTotal` | M | M | §2.8 |
| 27 | `cac:InvoiceLine` (1..n) | M | M | §2.9 |

Position-specific facts about the ADR/Signature block [SDK-VERIFIED] [SDK]:
- The SDK's signer inserts the QR `AdditionalDocumentReference` and `cac:Signature` immediately before `cac:AccountingSupplierParty`, and inserts `ext:UBLExtensions` as the first child of `Invoice`. It does this with **no surrounding whitespace**. The SDK's `xslt/addQRElement.xsl`, `addSignatureElement.xsl` and `addUBLElement.xsl` inside the jar show this.
- The samples therefore contain `…<Invoice …><ext:UBLExtensions>`, `…</cac:AdditionalDocumentReference><cac:Signature>` and `</cac:Signature><cac:AccountingSupplierParty>`.
- This is why the hash is unaffected by signing: nothing in the hashed region changes.

### 2.3 Seller: `cac:AccountingSupplierParty/cac:Party`
Order inside `cac:Party` per the XSD: `PartyIdentification`, `PostalAddress`, `PartyTaxScheme`, `PartyLegalEntity`. [SDK]

```xml
<cac:AccountingSupplierParty>
  <cac:Party>
    <cac:PartyIdentification>
      <cbc:ID schemeID="CRN">1010010000</cbc:ID>          <!-- BT-29 / BT-29-1 -->
    </cac:PartyIdentification>
    <cac:PostalAddress>
      <cbc:StreetName>…</cbc:StreetName>                  <!-- BT-35  M -->
      <cbc:AdditionalStreetName>…</cbc:AdditionalStreetName> <!-- BT-36 O -->
      <cbc:BuildingNumber>2322</cbc:BuildingNumber>       <!-- KSA-17 M, 4 digits (BR-KSA-37) -->
      <cbc:PlotIdentification>…</cbc:PlotIdentification>  <!-- KSA-23 O, "additional number" -->
      <cbc:CitySubdivisionName>…</cbc:CitySubdivisionName><!-- KSA-3 M, district -->
      <cbc:CityName>…</cbc:CityName>                      <!-- BT-37  M -->
      <cbc:PostalZone>23333</cbc:PostalZone>              <!-- BT-38  M, 5 digits (BR-KSA-66) -->
      <cbc:CountrySubentity>…</cbc:CountrySubentity>      <!-- BT-39  O -->
      <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country> <!-- BT-40 ISO 3166-1 alpha-2 -->
    </cac:PostalAddress>
    <cac:PartyTaxScheme>
      <cbc:CompanyID>399999999900003</cbc:CompanyID>      <!-- BT-31: 15 digits, first and last = 3 (BR-KSA-40) -->
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
    </cac:PartyTaxScheme>
    <cac:PartyLegalEntity>
      <cbc:RegistrationName>…</cbc:RegistrationName>      <!-- BT-27 seller name; also QR tag 1 -->
    </cac:PartyLegalEntity>
  </cac:Party>
</cac:AccountingSupplierParty>
```

Address element order is fixed by UBL `AddressType`: `StreetName, AdditionalStreetName, BuildingNumber, PlotIdentification, CitySubdivisionName, CityName, PostalZone, CountrySubentity, Country`. [SDK XSD]

Seller ID `schemeID` values (BR-KSA-08, warning) [SDK]:

| schemeID | Meaning |
|---|---|
| `CRN` | Commercial registration |
| `MOM` | MOMRAH licence |
| `MLS` | MHRSD licence |
| `700` | 700 number |
| `SAG` | MISA licence |
| `OTH` | Other |

The ID must be alphanumeric and appear only once. With several IDs, choose by the order above. With several CRs, use the branch CR.

Address rule BR-KSA-09 (warning) requires street, building number, postal code, city, district and country. The sandbox swagger shows the older error-level wording that also includes PlotIdentification (KSA-23).

### 2.4 Buyer: `cac:AccountingCustomerParty/cac:Party`
- **Standard (01)** [SDK]:
  - `PartyLegalEntity/RegistrationName` is required (BR-KSA-42).
  - If the buyer's country is `SA`, the address must contain street, building number, postal code (5 digits, BR-KSA-67), city, district and country (BR-KSA-63).
  - For a non-SA buyer: street, city, country (BR-KSA-10).
  - The buyer VAT number (BT-48) is 15 digits beginning and ending with 3 (BR-KSA-44). If it is absent, `PartyIdentification/ID@schemeID` must be present (BR-KSA-81 / BR-KSA-14).
- Buyer `schemeID` values (BR-KSA-14, error):

  | schemeID | Meaning |
  |---|---|
  | `TIN` | Tax identification number |
  | `CRN` | Commercial registration |
  | `MOM` | MOMRAH licence |
  | `MLS` | MHRSD licence |
  | `700` | 700 number |
  | `SAG` | MISA licence |
  | `NAT` | National ID |
  | `GCC` | GCC ID |
  | `IQA` | Iqama |
  | `PAS` | Passport |
  | `OTH` | Other |

- **Simplified (02)**: the buyer is optional, except:
  - VATEX-SA-EDU/HEA require the buyer name (BR-KSA-25) and `NAT` ID (BR-KSA-49, error);
  - summary invoices require the buyer name (BR-KSA-71).
- An export sample buyer uses `<cbc:ID schemeID="OTH">USxxxxxxxx1</cbc:ID>` and a US address without district or building number. [SDK]
- The seller VAT number must differ from the buyer VAT number (BR-CUSTOM-VALIDATION-01, error). [SDK]

### 2.5 Payment means code (BT-81)
[OFFICIAL] S-XML §11.2.5: subset of UNTDID 4461.

[SDK] BR-KSA-16 accepts `1`–`68`, `70`, `74`–`78`, `91`–`97` and `ZZZ`. Common values:

| Code | Meaning | Notes |
|---|---|---|
| `10` | In cash | Used in the samples |
| `30` | Credit transfer | Used in the samples |
| `42` | Payment to bank account | |
| `48` | Bank card | |
| `1` | Instrument not defined | |

### 2.6 Allowances and charges (document level)
[OFFICIAL] S-XML §9.4. [SDK]

```xml
<cac:AllowanceCharge>
  <cbc:ChargeIndicator>false</cbc:ChargeIndicator>          <!-- false=allowance, true=charge -->
  <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode> <!-- UNTDID 5189 (allowance) / 7161 (charge, BR-KSA-CL-06) -->
  <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
  <cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric>  <!-- percent, 0–100, ≤2 dp (BR-KSA-DEC-01) -->
  <cbc:Amount currencyID="SAR">200.00</cbc:Amount>          <!-- = BaseAmount × pct / 100 (BR-KSA-EN16931-03) -->
  <cbc:BaseAmount currencyID="SAR">2000.00</cbc:BaseAmount> <!-- base and pct must come together (BR-KSA-EN16931-04/05) -->
  <cac:TaxCategory>
    <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
    <cbc:Percent>15</cbc:Percent>                          <!-- required for all categories (S-XML §8.3) -->
    <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
  </cac:TaxCategory>
</cac:AllowanceCharge>
```

- `schemeID` and `schemeAgencyID` on the category and scheme IDs appear in the samples but are optional; plain `<cbc:ID>S</cbc:ID>` is accepted (the export sample uses it).
- Charges need a reason code (BR-KSA-19) and a reason text (BR-KSA-21).
- Charges at price level are not allowed: `cac:Price/cac:AllowanceCharge/cbc:ChargeIndicator` must be `false` (BR-KSA-EN16931-06, error).

### 2.7 TaxTotal: why there are two
[OFFICIAL] S-DD BT-110/BT-111. [SDK] BR-KSA-EN16931-08/09, BR-53, BR-KSA-97.

- **TaxTotal without `cac:TaxSubtotal`** = BT-111, the total VAT in the **tax accounting currency** (`TaxCurrencyCode`, always SAR). BR-KSA-EN16931-09: "Only one tax total (BG-22) without tax subtotals (BG-23) must be provided when tax currency code is provided". Because `TaxCurrencyCode` is mandatory (BR-KSA-68), this element is effectively always present.
- **TaxTotal with `cac:TaxSubtotal`s** = BT-110 plus the VAT breakdown (BG-23), in the **document currency** (BT-5). BR-KSA-EN16931-08: "Only one tax total (BG-22) with tax subtotals must be provided."
- For SAR invoices the two TaxAmounts are equal. For non-SAR invoices they must differ (BR-KSA-97). `currencyID` on BT-111 is SAR; every other amount uses the document currency (BR-KSA-CL-02, error).
- **Order:** every SDK sample puts the no-subtotal (SAR) TaxTotal **first**. The SDK's QR generator reads tag 5 from `/Invoice/cac:TaxTotal/cbc:TaxAmount`, which resolves to the first match (§5.3). **Keep the SAR / no-subtotal TaxTotal first.** [SDK-VERIFIED]
- One `cac:TaxSubtotal` per distinct (category, rate) pair. Trailing zeros do not create a new group: 15 and 15.00 are the same rate (S-XML §8.4).

```xml
<cac:TaxTotal>
  <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>          <!-- BT-111 -->
</cac:TaxTotal>
<cac:TaxTotal>
  <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>          <!-- BT-110 = Σ BT-117 (BR-CO-14, error) -->
  <cac:TaxSubtotal>
    <cbc:TaxableAmount currencyID="SAR">201.00</cbc:TaxableAmount> <!-- BT-116 = Σ line net + charges − allowances for this category -->
    <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>        <!-- BT-117 = round2(BT-116 × rate/100) (BR-CO-17 / BR-S-09, warnings) -->
    <cac:TaxCategory>
      <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <!-- for Z/E/O: <cbc:TaxExemptionReasonCode>VATEX-SA-…</cbc:TaxExemptionReasonCode>
                      <cbc:TaxExemptionReason>…text…</cbc:TaxExemptionReason>  (code BEFORE text: UBL order) -->
      <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
    </cac:TaxCategory>
  </cac:TaxSubtotal>
</cac:TaxTotal>
```

### 2.8 VAT categories and exemption reasons
[OFFICIAL] S-XML §11.2.4. Code-to-category mapping per [SDK] BR-KSA-CL-04 (3.4.8). Texts are from S-XML and the schematron.

| Category | Meaning | Rate | Reason code (BT-121) | Reason text (BT-120) |
|---|---|---|---|---|
| `S` | Standard rated | 15 or 5 (BR-KSA-84, error), > 0 | must NOT have a reason (BR-S-10) | — |
| `Z` | Zero rated | 0 | `VATEX-SA-32` | Export of goods |
| | | | `VATEX-SA-33` | Export of services |
| | | | `VATEX-SA-34-1` | The international transport of Goods |
| | | | `VATEX-SA-34-2` | International transport of passengers |
| | | | `VATEX-SA-34-3` | Services directly connected and incidental to a Supply of international passenger transport |
| | | | `VATEX-SA-34-4` | Supply of a qualifying means of transport |
| | | | `VATEX-SA-34-5` | Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations |
| | | | `VATEX-SA-35` | Medicines and medical equipment |
| | | | `VATEX-SA-36` | Qualifying metals |
| | | | `VATEX-SA-EDU` | Private education to citizen |
| | | | `VATEX-SA-HEA` | Private healthcare to citizen |
| | | | `VATEX-SA-MLTRY` | supply of qualified military goods |
| | | | `VATEX-SA-DIPLOMAT`, `VATEX-SA-DUTYFREE`, `VATEX-SA-ROYALDECREE` | Present in the SDK 3.4.8 BR-KSA-CL-04 list but **not in S-XML v1.2**. Official texts **UNVERIFIED**. |
| `E` | Exempt | 0 | `VATEX-SA-29` | Financial services mentioned in Article 29 of the VAT Regulations |
| | | | `VATEX-SA-29-7` | Life insurance services mentioned in Article 29 of the VAT Regulations |
| | | | `VATEX-SA-30` | Real estate transactions mentioned in Article 30 of the VAT Regulations |
| `O` | Not subject to VAT / out of scope | 0 or `Percent` omitted (since SDK 3.2.1) | `VATEX-SA-OOS` | Free text from the taxpayer |

Rules:
- Z/E/O need a reason code (BR-KSA-23/24/69, BR-KSA-CL-04) and a non-empty reason text (BR-KSA-83). In 3.4.8 the text is **not** compared to the official wording; the exact-match check is commented out in the XSL.
- The SDK samples use bilingual texts, e.g. `Export of goods | صادرات السلع من المملكة`.
- For O, Z and E, the category tax amount must be 0 (BR-O-09, BR-Z-09, BR-E-09).

### 2.9 LegalMonetaryTotal
[OFFICIAL] S-XML §9.2. Order per UBL `MonetaryTotalType`:

| # | Element | BT | Rule |
|---|---|---|---|
| 1 | `cbc:LineExtensionAmount` | BT-106 | Σ line BT-131 (BR-CO-10, warning) |
| 2 | `cbc:TaxExclusiveAmount` | BT-109 | BT-106 − BT-107 + BT-108 (BR-CO-13, warning) |
| 3 | `cbc:TaxInclusiveAmount` | BT-112 | BT-109 + BT-110 (BR-CO-15, **error**) |
| 4 | `cbc:AllowanceTotalAmount` | BT-107 | Σ document allowances (BR-CO-11, error) |
| 5 | `cbc:ChargeTotalAmount` | BT-108 | Σ document charges (BR-CO-12, error) |
| 6 | `cbc:PrepaidAmount` | BT-113 | |
| 7 | `cbc:PayableRoundingAmount` | BT-114 | |
| 8 | `cbc:PayableAmount` | BT-115 | BT-112 − BT-113 + BT-114 (BR-CO-16, warning) |

All of these amounts have at most 2 decimals (BR-DEC-*, warnings).

### 2.10 InvoiceLine
[OFFICIAL] S-XML §9.3. Order per UBL `InvoiceLineType`, `ItemType` and `PriceType`. [SDK]

```xml
<cac:InvoiceLine>
  <cbc:ID>1</cbc:ID>                                            <!-- BT-126, 1–6 chars -->
  <cbc:InvoicedQuantity unitCode="PCE">33.000000</cbc:InvoicedQuantity> <!-- BT-129, any decimals; unitCode UN/ECE Rec 20 recommended -->
  <cbc:LineExtensionAmount currencyID="SAR">99.00</cbc:LineExtensionAmount> <!-- BT-131 -->
  <!-- cac:DocumentReference (prepayment lines only, §1.4) -->
  <!-- cac:AllowanceCharge (line allowance/charge: ChargeIndicator, ReasonCode, Reason, MultiplierFactorNumeric, Amount, BaseAmount) -->
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">14.85</cbc:TaxAmount>       <!-- KSA-11 line VAT; M for standard (BR-KSA-52) -->
    <cbc:RoundingAmount currencyID="SAR">113.85</cbc:RoundingAmount> <!-- KSA-12 line amount INCL. VAT (= BT-131 + KSA-11, BR-KSA-51); M for standard (BR-KSA-53) -->
    <!-- cac:TaxSubtotal only on prepayment-adjustment lines -->
  </cac:TaxTotal>
  <cac:Item>
    <cbc:Name>كتاب</cbc:Name>                                   <!-- BT-153 -->
    <!-- cac:BuyersItemIdentification, cac:SellersItemIdentification, cac:StandardItemIdentification (each /cbc:ID) -->
    <cac:ClassifiedTaxCategory>
      <cbc:ID>S</cbc:ID>                                         <!-- BT-151 -->
      <cbc:Percent>15.00</cbc:Percent>                           <!-- BT-152 -->
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
    </cac:ClassifiedTaxCategory>
  </cac:Item>
  <cac:Price>
    <cbc:PriceAmount currencyID="SAR">3.00</cbc:PriceAmount>     <!-- BT-146 net unit price, any decimals -->
    <!-- <cbc:BaseQuantity unitCode="PCE">1</cbc:BaseQuantity>  BT-149 > 0 (BR-KSA-EN16931-12) -->
    <!-- <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator>
           <cbc:Amount>discount BT-147</cbc:Amount><cbc:BaseAmount>gross BT-148</cbc:BaseAmount></cac:AllowanceCharge>
         net = gross − discount (BR-KSA-EN16931-07, error) -->
  </cac:Price>
</cac:InvoiceLine>
```

`cbc:RoundingAmount` is repurposed by ZATCA to carry the **line amount including VAT**. It is not a rounding difference.

### 2.11 Rounding and arithmetic
[OFFICIAL] S-XML §9–§10. [SDK] rules as listed.

- **Half-up rounding** to 2 decimals for amounts. Examples: 123.4949 → 123.49; 123.4951 → 123.50.
- Unit price (BT-146), quantity and percentages may carry more decimals.
- Line net amount BT-131 = `round2(PriceAmount / BaseQuantity × InvoicedQuantity) + line charges − line allowances`. S-XML says the parts are rounded separately. BR-KSA-EN16931-11 is a warning; SDK 3.2.1 relaxed it to accept the unrounded BT-146.
- **Category VAT is computed on the category total, not as the sum of rounded line VATs.** S-XML §10: "VAT category tax amount … shall be rounded on document level and not as a summation of rounded Invoice line VAT amounts". So BT-117 = `round2(BT-116 × rate / 100)` (BR-CO-17 / BR-S-09, warnings). Expect occasional 0.01 differences between Σ KSA-11 and BT-117; that is allowed.
- **Errors (rejection):** BR-CO-14 (BT-110 = Σ BT-117), BR-CO-15 (BT-112 = BT-109 + BT-110), BR-CO-11/12.
- **Warnings only:** BR-CO-10/13/16/17, BR-S-08/09, BR-KSA-51, BR-KSA-EN16931-11.
- Use decimal arithmetic in TypeScript (e.g. `decimal.js` or integer halalas). Never use IEEE floats for these values.

### 2.12 Annotated official examples
The two documents below are copied **verbatim** from the official SDK 3.4.8:
- `reference-samples/zatca-sdk/extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/Data/Samples/Simplified/Invoice/Simplified_Invoice.xml`
- `…/Data/Samples/Standard/Invoice/Standard_Invoice.xml`

Both pass ZATCA's validator. Do **not** edit them if you use them as test vectors: any byte change inside the hashed region changes the hash.

The annotations are kept outside the XML, keyed by line number, because comments inside the XML would change the hash.

#### 2.12.1 Simplified tax invoice (B2C, reporting): `Simplified_Invoice.xml`

| Lines | What | Notes |
|---|---|---|
| 1 | XML declaration | Dropped by C14N; included in the API `invoice` base64 |
| 2 | Root `Invoice` + 4 namespace declarations, immediately followed by `<ext:UBLExtensions>` | No whitespace between them, because the SDK inserts it |
| 2–67 | `ext:UBLExtensions` → XAdES signature | §4.2. Note `ds:Signature Id="signature"`, the two References, and the SignedProperties layout. |
| 28 | Invoice hash (b64 raw) | Same value as QR tag 6 |
| 32 | SignedProperties digest (b64 **of hex**) | |
| 35 | SignatureValue | DER ECDSA, base64 |
| 50 | CertDigest (b64 of hex of SHA-256 of the cert base64 text) | |
| 53–54 | IssuerName (`", "` separators), serial in decimal | |
| 69–77 | ProfileID, ID, UUID, IssueDate, IssueTime, InvoiceTypeCode `name="0200000"`, Note, currencies | |
| 78–81 | ICV = `10` | |
| 82–87 | PIH = genesis value | |
| 90–95 | QR ADR | Its closing tag is followed directly by `<cac:Signature>` |
| 95–98 | `cac:Signature` | Directly followed by `<cac:AccountingSupplierParty>` |
| 98–123 | Seller with CRN, national address, VAT, legal name (bilingual "AR \| EN" is fine) | |
| 124–125 | **Empty** buyer element | Allowed for simplified |
| 126–128 | PaymentMeans 10 (cash) | |
| 129–147 | Document-level allowance of 0.00 | Two TaxCategory children; legal in UBL; shows `schemeID`/`schemeAgencyID` usage |
| 148–150 | TaxTotal #1 (BT-111, SAR, no subtotal) | |
| 151–164 | TaxTotal #2 (BT-110 + breakdown, S 15%) | Taxable 201.00 → VAT 30.15 |
| 165–172 | LegalMonetaryTotal | 201.00 / 201.00 / 231.15 / 0.00 / 0.00 / 231.15 |
| 173–216 | Two lines | 33 × 3.00 = 99.00 (+14.85 VAT = 113.85); 3 × 34.00 = 102.00 (+15.30 = 117.30). Σ line VAT 30.15 = category VAT. |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions>
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation> 
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>z5F9qsS6oWyDhehD8u8S0DaxV+2CUiUz9Y+UsR61JgQ=</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>ZmMwY2ZhNDljNzNjZDA5NmY4NDM4MmY1ZmY1YTA0NjY3MzY4NzMxOGJhYmZmNWU1OGYzZWJlODI3ZDgyZGVkZA==</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>MEYCIQCYovp/Gxd/x2qZcDZZf+4TdtfZjU/1/fzS3EQjmZGhlQIhANTc0rlAs3ffQgrKi8V49eXV32d200XIutgCti4iGAjB</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>MIID3jCCA4SgAwIBAgITEQAAOAPF90Ajs/xcXwABAAA4AzAKBggqhkjOPQQDAjBiMRUwEwYKCZImiZPyLGQBGRYFbG9jYWwxEzARBgoJkiaJk/IsZAEZFgNnb3YxFzAVBgoJkiaJk/IsZAEZFgdleHRnYXp0MRswGQYDVQQDExJQUlpFSU5WT0lDRVNDQTQtQ0EwHhcNMjQwMTExMDkxOTMwWhcNMjkwMTA5MDkxOTMwWjB1MQswCQYDVQQGEwJTQTEmMCQGA1UEChMdTWF4aW11bSBTcGVlZCBUZWNoIFN1cHBseSBMVEQxFjAUBgNVBAsTDVJpeWFkaCBCcmFuY2gxJjAkBgNVBAMTHVRTVC04ODY0MzExNDUtMzk5OTk5OTk5OTAwMDAzMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeKOCAgcwggIDMIGtBgNVHREEgaUwgaKkgZ8wgZwxOzA5BgNVBAQMMjEtVFNUfDItVFNUfDMtZWQyMmYxZDgtZTZhMi0xMTE4LTliNTgtZDlhOGYxMWU0NDVmMR8wHQYKCZImiZPyLGQBAQwPMzk5OTk5OTk5OTAwMDAzMQ0wCwYDVQQMDAQxMTAwMREwDwYDVQQaDAhSUlJEMjkyOTEaMBgGA1UEDwwRU3VwcGx5IGFjdGl2aXRpZXMwHQYDVR0OBBYEFEX+YvmmtnYoDf9BGbKo7ocTKYK1MB8GA1UdIwQYMBaAFJvKqqLtmqwskIFzVvpP2PxT+9NnMHsGCCsGAQUFBwEBBG8wbTBrBggrBgEFBQcwAoZfaHR0cDovL2FpYTQuemF0Y2EuZ292LnNhL0NlcnRFbnJvbGwvUFJaRUludm9pY2VTQ0E0LmV4dGdhenQuZ292LmxvY2FsX1BSWkVJTlZPSUNFU0NBNC1DQSgxKS5jcnQwDgYDVR0PAQH/BAQDAgeAMDwGCSsGAQQBgjcVBwQvMC0GJSsGAQQBgjcVCIGGqB2E0PsShu2dJIfO+xnTwFVmh/qlZYXZhD4CAWQCARIwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMCMCcGCSsGAQQBgjcVCgQaMBgwCgYIKwYBBQUHAwMwCgYIKwYBBQUHAwIwCgYIKoZIzj0EAwIDSAAwRQIhALE/ichmnWXCUKUbca3yci8oqwaLvFdHVjQrveI9uqAbAiA9hC4M8jgMBADPSzmd2uiPJA6gKR3LE03U75eqbC/rXA==</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                <xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>2025-07-22T15:51:28</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue>ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>379112742831380471835263969587287663520528387</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>

    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>SME00010</cbc:ID>
    <cbc:UUID>8e6000cf-1a98-4174-b3e7-b5d5954bc10d</cbc:UUID>
    <cbc:IssueDate>2022-08-17</cbc:IssueDate>
    <cbc:IssueTime>17:41:08</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
    <cbc:Note languageID="ar">ABC</cbc:Note>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>10</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    
    
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AW/YtNix2YPYqSDYqtmI2LHZitivINin2YTYqtmD2YbZiNmE2YjYrNmK2Kcg2KjYo9mC2LXZiSDYs9ix2LnYqSDYp9mE2YXYrdiv2YjYr9ipIHwgTWF4aW11bSBTcGVlZCBUZWNoIFN1cHBseSBMVEQCDzM5OTk5OTk5OTkwMDAwMwMTMjAyMi0wOC0xN1QxNzo0MTowOAQGMjMxLjE1BQUzMC4xNQYsejVGOXFzUzZvV3lEaGVoRDh1OFMwRGF4VisyQ1VpVXo5WStVc1I2MUpnUT0HYE1FWUNJUUNZb3ZwL0d4ZC94MnFaY0RaWmYrNFRkdGZaalUvMS9melMzRVFqbVpHaGxRSWhBTlRjMHJsQXMzZmZRZ3JLaThWNDllWFYzMmQyMDBYSXV0Z0N0aTRpR0FqQghYMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeAlHMEUCIQCxP4nIZp1lwlClG3Gt8nIvKKsGi7xXR1Y0K73iPbqgGwIgPYQuDPI4DAQAz0s5ndrojyQOoCkdyxNN1O+Xqmwv61w=</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
</cac:AdditionalDocumentReference><cac:Signature>
      <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
      <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
</cac:Signature><cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="CRN">1010010000</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>الامير سلطان | Prince Sultan</cbc:StreetName>
                <cbc:BuildingNumber>2322</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>المربع | Al-Murabba</cbc:CitySubdivisionName>
                <cbc:CityName>الرياض | Riyadh</cbc:CityName>
                <cbc:PostalZone>23333</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>399999999900003</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>شركة توريد التكنولوجيا بأقصى سرعة المحدودة | Maximum Speed Tech Supply LTD</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
     <cac:AccountingCustomerParty>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
    <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="SAR">0.00</cbc:Amount>
        <cac:TaxCategory>
            <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
            <cbc:Percent>15</cbc:Percent>
            <cac:TaxScheme>
                <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
            </cac:TaxScheme>
        </cac:TaxCategory>
        <cac:TaxCategory>
            <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
            <cbc:Percent>15</cbc:Percent>
            <cac:TaxScheme>
                <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
            </cac:TaxScheme>
        </cac:TaxCategory>
    </cac:AllowanceCharge>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="SAR">201.00</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="SAR">30.15</cbc:TaxAmount>
             <cac:TaxCategory>
                 <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
                 <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                   <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
                </cac:TaxScheme>
             </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="SAR">201.00</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="SAR">201.00</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="SAR">231.15</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
        <cbc:PayableAmount currencyID="SAR">231.15</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
    <cac:InvoiceLine>
        <cbc:ID>1</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">33.000000</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="SAR">99.00</cbc:LineExtensionAmount>
        <cac:TaxTotal>
             <cbc:TaxAmount currencyID="SAR">14.85</cbc:TaxAmount>
             <cbc:RoundingAmount currencyID="SAR">113.85</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>كتاب</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="SAR">3.00</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
    <cac:InvoiceLine>
        <cbc:ID>2</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">3.000000</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="SAR">102.00</cbc:LineExtensionAmount>
        <cac:TaxTotal>
             <cbc:TaxAmount currencyID="SAR">15.30</cbc:TaxAmount>
             <cbc:RoundingAmount currencyID="SAR">117.30</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>قلم</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="SAR">34.00</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
</Invoice>
```

#### 2.12.2 Standard tax invoice (B2B, clearance): `Standard_Invoice.xml`

| Lines | What | Notes |
|---|---|---|
| 2–67 | UBLExtensions | Optional for standard documents; ZATCA re-stamps at clearance |
| 74 | `InvoiceTypeCode name="0100000"` | 388 |
| 77–80 | ICV `23` | |
| 81–86 | PIH | |
| 89–94 | QR with tags 1–8 only (no tag 9) | Tag 5 = `0.6`, mirroring the XML text `0.6` |
| 94–97 | `cac:Signature` | |
| 123–145 | Buyer | SA address (street, building, district, city, postal), VAT `399999999800003`, legal name. Satisfies BR-KSA-42/44/63. |
| 146–148 | `cac:Delivery/cbc:ActualDeliveryDate` | Supply date, required for standard 388 (BR-KSA-15) |
| 149–151 | PaymentMeans 10 | |
| 152–163 | Document-level allowance of 0.00 | |
| 164–180 | Two TaxTotals | `0.6` / `0.6` with subtotal 4.00 → 0.60 |
| 181–188 | Totals | 4.00 / 4.00 / 4.60 / 0.00 / 0.00 / 4.60 |
| 189–210 | One line | 2 × 2.00 = 4.00; VAT 0.60; incl. 4.60 |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions>
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation> 
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>V4U5qlZ3yXQ/Si1AC/R8SLc3F+iNy27wdVe8IWRqFAQ=</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>ODhlZTRmYmY3YWUzZWFjMDFmMThiZGI4OWMwMDVhMWQzMTNkZmE3MjNlMmFhYzc2Y2ZjZGM3NGMxZjc2ZWE5Yw==</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>MEUCIQCP9/y0oNgY+oIZyBMGx0eCRvcEKHsGybjFrneJlYVkwQIgBjyffZRZUD797Zs/bW2k027C6mDMMtVreOLhDmP+tz0=</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>MIID3jCCA4SgAwIBAgITEQAAOAPF90Ajs/xcXwABAAA4AzAKBggqhkjOPQQDAjBiMRUwEwYKCZImiZPyLGQBGRYFbG9jYWwxEzARBgoJkiaJk/IsZAEZFgNnb3YxFzAVBgoJkiaJk/IsZAEZFgdleHRnYXp0MRswGQYDVQQDExJQUlpFSU5WT0lDRVNDQTQtQ0EwHhcNMjQwMTExMDkxOTMwWhcNMjkwMTA5MDkxOTMwWjB1MQswCQYDVQQGEwJTQTEmMCQGA1UEChMdTWF4aW11bSBTcGVlZCBUZWNoIFN1cHBseSBMVEQxFjAUBgNVBAsTDVJpeWFkaCBCcmFuY2gxJjAkBgNVBAMTHVRTVC04ODY0MzExNDUtMzk5OTk5OTk5OTAwMDAzMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeKOCAgcwggIDMIGtBgNVHREEgaUwgaKkgZ8wgZwxOzA5BgNVBAQMMjEtVFNUfDItVFNUfDMtZWQyMmYxZDgtZTZhMi0xMTE4LTliNTgtZDlhOGYxMWU0NDVmMR8wHQYKCZImiZPyLGQBAQwPMzk5OTk5OTk5OTAwMDAzMQ0wCwYDVQQMDAQxMTAwMREwDwYDVQQaDAhSUlJEMjkyOTEaMBgGA1UEDwwRU3VwcGx5IGFjdGl2aXRpZXMwHQYDVR0OBBYEFEX+YvmmtnYoDf9BGbKo7ocTKYK1MB8GA1UdIwQYMBaAFJvKqqLtmqwskIFzVvpP2PxT+9NnMHsGCCsGAQUFBwEBBG8wbTBrBggrBgEFBQcwAoZfaHR0cDovL2FpYTQuemF0Y2EuZ292LnNhL0NlcnRFbnJvbGwvUFJaRUludm9pY2VTQ0E0LmV4dGdhenQuZ292LmxvY2FsX1BSWkVJTlZPSUNFU0NBNC1DQSgxKS5jcnQwDgYDVR0PAQH/BAQDAgeAMDwGCSsGAQQBgjcVBwQvMC0GJSsGAQQBgjcVCIGGqB2E0PsShu2dJIfO+xnTwFVmh/qlZYXZhD4CAWQCARIwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMCMCcGCSsGAQQBgjcVCgQaMBgwCgYIKwYBBQUHAwMwCgYIKwYBBQUHAwIwCgYIKoZIzj0EAwIDSAAwRQIhALE/ichmnWXCUKUbca3yci8oqwaLvFdHVjQrveI9uqAbAiA9hC4M8jgMBADPSzmd2uiPJA6gKR3LE03U75eqbC/rXA==</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                <xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>2025-07-22T15:38:47</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue>ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>379112742831380471835263969587287663520528387</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>
    
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>SME00023</cbc:ID>
    <cbc:UUID>8d487816-70b8-4ade-a618-9d620b73814a</cbc:UUID>
    <cbc:IssueDate>2022-09-07</cbc:IssueDate>
    <cbc:IssueTime>12:21:28</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>23</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    
    
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AW/YtNix2YPYqSDYqtmI2LHZitivINin2YTYqtmD2YbZiNmE2YjYrNmK2Kcg2KjYo9mC2LXZiSDYs9ix2LnYqSDYp9mE2YXYrdiv2YjYr9ipIHwgTWF4aW11bSBTcGVlZCBUZWNoIFN1cHBseSBMVEQCDzM5OTk5OTk5OTkwMDAwMwMTMjAyMi0wOS0wN1QxMjoyMToyOAQENC42MAUDMC42BixWNFU1cWxaM3lYUS9TaTFBQy9SOFNMYzNGK2lOeTI3d2RWZThJV1JxRkFRPQdgTUVVQ0lRQ1A5L3kwb05nWStvSVp5Qk1HeDBlQ1J2Y0VLSHNHeWJqRnJuZUpsWVZrd1FJZ0JqeWZmWlJaVUQ3OTdacy9iVzJrMDI3QzZtRE1NdFZyZU9MaERtUCt0ejA9CFgwVjAQBgcqhkjOPQIBBgUrgQQACgNCAAShYIprRJr0UgStM6/S4CQLVUgpfFT2c+nHa+V/jKEx6PLxzTZcluUOru0/J2jyarRqE4yY2jyDCeLte3UpP1R4</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
</cac:AdditionalDocumentReference><cac:Signature>
      <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
      <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
</cac:Signature><cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="CRN">1010010000</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>الامير سلطان | Prince Sultan</cbc:StreetName>
                <cbc:BuildingNumber>2322</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>المربع | Al-Murabba</cbc:CitySubdivisionName>
                <cbc:CityName>الرياض | Riyadh</cbc:CityName>
                <cbc:PostalZone>23333</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>399999999900003</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>شركة توريد التكنولوجيا بأقصى سرعة المحدودة | Maximum Speed Tech Supply LTD</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
     <cac:AccountingCustomerParty>
        <cac:Party>
            <cac:PostalAddress>
                <cbc:StreetName>صلاح الدين | Salah Al-Din</cbc:StreetName>
                <cbc:BuildingNumber>1111</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>المروج | Al-Murooj</cbc:CitySubdivisionName>
                <cbc:CityName>الرياض | Riyadh</cbc:CityName>
                <cbc:PostalZone>12222</cbc:PostalZone>
                <cac:Country>
                    <cbc:IdentificationCode>SA</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>399999999800003</cbc:CompanyID>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>شركة نماذج فاتورة المحدودة | Fatoora Samples LTD</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingCustomerParty>
    <cac:Delivery>
        <cbc:ActualDeliveryDate>2022-09-07</cbc:ActualDeliveryDate>
    </cac:Delivery>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
    <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
        <cbc:Amount currencyID="SAR">0.00</cbc:Amount>
        <cac:TaxCategory>
            <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
            <cbc:Percent>15</cbc:Percent>
            <cac:TaxScheme>
                <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
            </cac:TaxScheme>
        </cac:TaxCategory>
    </cac:AllowanceCharge>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">0.6</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="SAR">0.6</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="SAR">4.00</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="SAR">0.60</cbc:TaxAmount>
             <cac:TaxCategory>
                 <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>
                 <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                   <cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID>
                </cac:TaxScheme>
             </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="SAR">4.00</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="SAR">4.00</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="SAR">4.60</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
        <cbc:PayableAmount currencyID="SAR">4.60</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
    <cac:InvoiceLine>
        <cbc:ID>1</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">2.000000</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="SAR">4.00</cbc:LineExtensionAmount>
        <cac:TaxTotal>
             <cbc:TaxAmount currencyID="SAR">0.60</cbc:TaxAmount>
             <cbc:RoundingAmount currencyID="SAR">4.60</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>قلم رصاص</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:ID>S</cbc:ID>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme>
                    <cbc:ID>VAT</cbc:ID>
                </cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="SAR">2.00</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>
</Invoice>
```

---

## 3. Invoice hash (KSA-13 input, `ds:Reference[@Id='invoiceSignedData']/ds:DigestValue`, QR tag 6, API `invoiceHash`)

### 3.1 Algorithm
[SDK-VERIFIED] on all 19 SDK samples, 19 out of 19 matching. Also [OFFICIAL] S-SEC §2.3.3/§3, S-DTG §5.2 step 1, BR-KSA-26 text.

1. Take the **final** XML document, the exact bytes you will submit, and parse it with whitespace preserved.
2. Remove these element nodes. ZATCA's SDK uses this XSLT, found in the SDK jar at `xslt/removeElements.xsl`:
   ```xml
   <xsl:template match="//*[local-name()='Invoice']//*[local-name()='UBLExtensions']"></xsl:template>
   <xsl:template match="//*[local-name()='AdditionalDocumentReference'][cbc:ID[normalize-space(text()) = 'QR']]"></xsl:template>
   <xsl:template match="//*[local-name()='Invoice']/*[local-name()='Signature']"></xsl:template>
   ```
   The XMLDSig transforms in the signature say the same thing: `not(//ancestor-or-self::ext:UBLExtensions)`, `not(//ancestor-or-self::cac:Signature)`, `not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])`.
3. **Remove only the elements. Leave the whitespace text nodes before and after them in place.** In DOM terms, `parent.removeChild(el)` and nothing else. Libraries such as lxml attach the following whitespace to the element ("tail") and drop it on removal; you must re-attach it.
   - Keeping the whitespace gives `z5F9qsS6oWyDhehD8u8S0DaxV+2CUiUz9Y+UsR61JgQ=` for `Simplified_Invoice.xml`, which matches the file.
   - Dropping it gives `xmSwaAmlR37Q5kBS0AqSUMfy6b1ITQ5LCZR8O7Jkwe8=`, which is wrong.
4. Canonicalize with **C14N 1.1** (`http://www.w3.org/2006/12/xml-c14n11`), inclusive and without comments. C14N 1.1 differs from C14N 1.0 only in how it handles `xml:id`, `xml:base` and other inherited `xml:*` attributes, which ZATCA invoices do not contain. I used lxml's C14N 1.0 and matched all 19 samples. C14N drops the XML declaration, so step 3 of S-DTG ("Remove the XML version") happens automatically.
5. SHA-256 the canonical UTF-8 bytes.
6. **Base64 the 32 raw bytes.** Do not base64 the hex string. S-DTG: "Encode the hashed invoice using base64 … Using HEX-to Base64 Encoder".

What the canonical form looks like for `Simplified_Invoice.xml`, as the first bytes and the join where QR and Signature were removed:
```
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="…" xmlns:cbc="…" xmlns:ext="…">\n\n    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>\n    <cbc:ID>SME00010</cbc:ID>…
…</cac:AdditionalDocumentReference>\n    \n    \n    <cac:AccountingSupplierParty>…
```
(6,626 bytes in total.) The leftover `\n    \n    ` runs are exactly what the zatca-xml-js "dumb workaround" re-inserts by string replacement. Its XML library drops whitespace on delete. [COMMUNITY] https://github.com/wes4m/zatca-xml-js/blob/main/src/zatca/signing/index.ts

**Implementation rule for the TS library:**
- Generate the unsigned XML.
- Compute the hash by removing the three nodes, keeping whitespace, from the same serialized document you will sign.
- Insert UBLExtensions, the QR ADR and `cac:Signature` **without adding whitespace inside the hashed region**, as the SDK does. Equivalently, re-hash the final document and assert equality.
- Never pretty-print after hashing.
- Always emit LF line endings. Parsers normalize CRLF to LF before C14N anyway, but the SignedProperties hash in §4.4 is string-based.

### 3.2 PIH (KSA-13) chain
- First document of an EGS: `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==`. [OFFICIAL] BR-KSA-26; SDK `Data/PIH/pih.txt`.
  - [SDK-VERIFIED] It decodes to the ASCII hex `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9` = SHA-256("0").
  - This is the **only** PIH that is base64-of-hex (88 characters). All later PIHs are base64 of raw bytes (44 characters).
- Each subsequent document's PIH = the invoice hash of the **previously generated** document of the same EGS. [OFFICIAL] S-DTG §4.3:
  - There is one chain per EGS unit, shared across standard and simplified documents.
  - Rejected documents still count in the chain; the platform records rejected hashes.
  - Documents may be *submitted* out of order as long as they were *generated* in sequence; gaps are investigated in the backend.
- ICV (KSA-16): a strictly increasing counter per EGS, never reused, including for rejected documents. After a rejection, resubmit as a **new** document with a new UUID, ICV, hash and timestamp. [OFFICIAL] S-DTG FAQ.

---

## 4. Signing: XAdES-B-B enveloped signature in `ext:UBLExtensions`

### 4.1 Cryptography
- Key: EC **secp256k1** (OID 1.3.132.0.10). [SDK] The dummy key and every ZATCA-issued certificate use secp256k1. S-SEC #16 says "ECDSA, SHA-256, key length 256".
- Signature: ECDSA with SHA-256, **DER-encoded** (`SEQUENCE{INTEGER r, INTEGER s}`, 70–72 bytes), then base64. [SDK-VERIFIED] `SignatureValue` in the sample begins `0x30`, length 72.
- **What is signed:** the 32 raw invoice-hash bytes, passed as the *message* to SHA256withECDSA. The SDK's `com/zatca/sdk/util/ECDSAUtil` uses `SHA256withECDSA`.
  - [SDK-VERIFIED] `openssl dgst -sha256 -verify pub.pem -signature sig.der <32 hash bytes>` gives **Verified OK**.
  - Verifying against the canonical `ds:SignedInfo` fails. Verifying against the base64 hash string fails. Verifying the raw prehash without an extra SHA-256 fails.
- Consequence: `ds:SignedInfo` (and therefore the SignedProperties digest) is **not** covered by the ECDSA signature. ZATCA validates every component separately; see the error codes in §8.3. Do not use a generic XMLDSig library's "sign SignedInfo" path.
- [COMMUNITY] Libraries disagree here:
  - zatca-xml-js, aashahin/zatca-sdk and ERPGulf sign the hash bytes, as the SDK does.
  - `@talha7k/zatca` signs canonical SignedInfo and also claims acceptance.
  - Whether ZATCA's validator accepts both is **UNVERIFIED**. Follow the SDK, the only form proven against ZATCA's own samples.
- **Node.js/TypeScript note:** WebCrypto does **not** support secp256k1. Use one of:
  - Node's `crypto.createSign('sha256')` with an EC key (OpenSSL in Node supports secp256k1), which yields DER by default;
  - `@noble/curves/secp256k1`. If you sign the pre-hash with noble, pass `sha256(hashBytes)` and use `.toDERRawBytes()`, and follow ZATCA's sample, which uses randomized nonces. RFC6979 deterministic nonces are also valid ECDSA.

### 4.2 UBLExtensions template (exact SDK layout)
[SDK-VERIFIED] Taken from `Data/Samples/Simplified/Invoice/Simplified_Invoice.xml`. The SDK's internal template `xml/ubl.xml` has the same structure. **The indentation inside `xades:SignedProperties` matters** (§4.4). Keep the layout exactly as shown, LF line endings, and the `<ext:UBLExtensions>` start tag directly after the `<Invoice …>` start tag.

```xml
<ext:UBLExtensions>
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation> 
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>{INVOICE_HASH_B64_RAW}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>{SIGNED_PROPERTIES_HASH_B64_OF_HEX}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>{ECDSA_DER_B64}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>{CERT_BASE64_DER_NO_HEADERS_NO_NEWLINES}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                <xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>{YYYY-MM-DDTHH:mm:ss}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue>{CERT_HASH_B64_OF_HEX}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>{ISSUER_RFC2253_COMMA_SPACE}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>{SERIAL_DECIMAL}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>
```

Notes:
- `sac:SignatureInformation> ` has a trailing space in the SDK samples and in `ubl.xml`. It is outside SignedProperties and outside the invoice hash, so it is irrelevant. [SDK]
- The `cbc` prefix inside UBLExtensions resolves through the root declaration.
- The second Reference's `Type` is `http://www.w3.org/2000/09/xmldsig#SignatureProperties` in the SDK. S-SEC says `http://uri.etsi.org/01903#SignedProperties`. **Use the SDK value.** [SDK]
- S-SEC lists `SigningCertificateV2`, `SignaturePolicyIdentifier` and `SignedDataObjectProperties/DataObjectFormat/MimeType`. **The SDK uses only `SigningTime` and `SigningCertificate` (v1).** Follow the SDK; extra properties would change the SignedProperties hash and are untested. [SDK]
- BR-KSA-28 (error) requires `sac:SignatureInformation/cbc:ID` = `urn:oasis:names:specification:ubl:signature:1`. BR-KSA-29 requires `sbc:ReferencedSignatureID` and `cac:Signature/cbc:ID` = `urn:oasis:names:specification:ubl:signature:Invoice`. BR-KSA-30 (error) requires `cac:Signature/cbc:SignatureMethod` = `urn:oasis:names:specification:ubl:dsig:enveloped:xades`.

### 4.3 Certificate-derived values
[SDK-VERIFIED]

| Field | Computation | Value for the SDK dummy certificate |
|---|---|---|
| `ds:X509Certificate` | Base64 DER, one line, no PEM armour. For API-issued certificates this is `base64decode(binarySecurityToken)` as a string. | `MIID3jCCA4SgAwIBAgITEQAAOAPF90Ajs/xcXwABAAA4AzAKBggqhkjOPQQDAjBi…` |
| CertDigest | `base64( hex_lower( sha256( ascii(X509Certificate text) ) ) )` | hex `d302b411575c956598c5e88abb4856452556a5ab8a01f7acb95a069d46662485` → `ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==` |
| `ds:X509IssuerName` | Issuer RDNs in RFC 2253 order (reverse of DER order), each `TYPE=value`, joined by `", "` (comma and space) | `CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local` |
| `ds:X509SerialNumber` | Serial as an unsigned **decimal** integer. Use BigInt; the value exceeds 2^53. | hex `1100003803C5F74023B3FC5C5F000100003803` → `379112742831380471835263969587287663520528387` |

The tempting alternatives do **not** match: `b64(sha256(DER))`, `b64(hex(sha256(DER)))` and `b64(sha256(base64 text))` all fail. Only base64-of-hex over the base64 *text* matches. S-DTG Step 3 shows a hex example, then a base64-of-hex example, which is consistent with this. [OFFICIAL] [SDK-VERIFIED]

Node: `new crypto.X509Certificate(pem).issuer` returns `DC=local\nDC=gov\nDC=extgazt\nCN=PRZEINVOICESCA4-CA`; reverse it and join with `", "`. `x509.serialNumber` is hex; convert with `BigInt('0x' + hex).toString(10)`. [COMMUNITY] (zatca-xml-js does exactly this)

Issuers you will meet:
- Production and simulation PCSIDs come from a ZATCA CA, e.g. `PRZEINVOICESCA4-CA` or `PRZEINVOICESCA1-CA` with `DC=extgazt,DC=gov,DC=local`.
- Compliance CSIDs (CCSID) are self-signed by the platform with issuer `CN=eInvoicing`. [OFFICIAL] S-OAS examples, decoded.

### 4.4 SignedProperties digest (the whitespace quirk)
[SDK-VERIFIED] It is computed over this exact string, here for `Simplified_Invoice.xml`. LF line endings; the leading indentation of the *first* line is not included; every following line keeps the indentation it has in the document:

```
<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>2025-07-22T15:51:28</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">379112742831380471835263969587287663520528387</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>
```

The hex SHA-256 is `fc0cfa49c73cd096f84382f5ff5a046673687318babff5e58f3ebe827d82dedd`. Base64 of that hex string gives `ZmMwY2ZhNDljNzNjZDA5NmY4NDM4MmY1ZmY1YTA0NjY3MzY4NzMxOGJhYmZmNWU1OGYzZWJlODI3ZDgyZGVkZA==`, which matches the sample.

Rules derived from this:
- The bytes hashed are the SignedProperties element **as it sits in the emitted document**: same inner whitespace, self-closing `ds:DigestMethod`, plus namespace declarations. Each element that uses a prefix declared on an ancestor outside the subtree gets that declaration: `xades` on the SignedProperties element and `ds` on each `ds:` element. Declarations are inserted as the **first** attribute.
- This looks like a DOM-to-string serialization of the detached node, not C14N. Inclusive C14N, exclusive C14N, a "linearized" (whitespace-stripped) variant, and a variant with the empty element expanded all **fail** to match.
- **Encoding:** base64 of the **hex** string. This differs from the invoice hash, which is base64 of raw bytes.
- ZATCA re-derives this from the submitted document. So any indentation works **if and only if** you hash the same text you emit. zatca-xml-js got this wrong once and patched it with `signedPropertiesIndentationFix` by stripping 4 spaces. [COMMUNITY] The safest approach is to copy the SDK layout byte-for-byte. Whether the platform accepts a *different but self-consistent* indentation is **UNVERIFIED**, but highly likely given how it validates.
- The official S-DTG Step 5 says "Linearize the XML block (properties tag) and remove the spaces" and shows a base64-of-raw-bytes example. **That contradicts the SDK samples. Do not follow it.**

### 4.5 SigningTime
- SDK samples: `2025-07-22T15:51:28`, i.e. `YYYY-MM-DDTHH:mm:ss` with no zone and no fraction. [SDK]
- zatca-xml-js appends `Z` to a local-time value. [COMMUNITY]
- zatca-kit ("traps" list, live-tested per its README) says SigningTime must be UTC. [COMMUNITY]
- **Recommendation:** emit the UTC time as `YYYY-MM-DDTHH:mm:ss` without a suffix. Acceptance of a `Z` suffix is **UNVERIFIED**.
- S-SEC #13: signing time comes from the EGS clock.

### 4.6 Signing procedure (TS pseudocode)
```
xml0         = buildUnsignedInvoice()                 // no UBLExtensions / QR ADR / cac:Signature, LF, no pretty-print later
invoiceHashB = sha256(c14n11(removeNodesKeepWhitespace(xml0)))     // 32 bytes
invoiceHash  = base64(invoiceHashB)
sigDER       = ecdsaSecp256k1Sign(key, sha256(invoiceHashB))      // == SHA256withECDSA(message=invoiceHashB)
signatureB64 = base64(sigDER)
certB64      = certificate base64 text (no headers/newlines)
certDigest   = base64(hex(sha256(utf8(certB64))))
issuer       = reverse(issuerRDNs).join(", ") ; serial = BigInt(hexSerial).toString(10)
spText       = renderSignedProperties(signingTime, certDigest, issuer, serial) // exact indentation of §4.2
spDigest     = base64(hex(sha256(utf8(withNsDecls(spText)))))              // §4.4
qr           = buildQR(...)                                               // §5 (needs invoiceHash, signatureB64, cert)
xml1         = insert UBLExtensions (first child), QR ADR + cac:Signature (before AccountingSupplierParty), no extra whitespace
assert sha256(c14n11(removeNodesKeepWhitespace(xml1))) == invoiceHashB
```

### 4.7 Standard (B2B) documents
- [OFFICIAL] S-DTG §4.3.2: "The Seller may optionally include its Cryptographic Stamp and QR code … the response from ZATCA's FATOORA Platform will add an additional Stamp to the document and update the QR code."
- S-DPM §2.3.10.6: for clearance the SDK only needs `-generateHash`.
- The cleared invoice returned by the platform (`clearedInvoice`) is the version to give to the buyer.
- In the sandbox examples the returned document is signed again and its QR contains tags 1–8 (no tag 9). [OFFICIAL] S-OAS CLEARANCE examples, decoded.

---

## 5. QR code (KSA-14)

### 5.1 Encoding
[OFFICIAL] S-SEC §4.1, S-DTG §6. [SDK-VERIFIED] by decoding all sample QRs.

- Bytes: `TAG LEN VALUE`, repeated with no separators, then **standard base64 with padding**.
- LEN is the length of the value **in bytes**. Arabic seller names count UTF-8 bytes; the sample's 74-character name is 111 bytes.
- **LEN encoding: the documents and the SDK disagree; follow the SDK.**
  - S-SEC and S-DTG say the length is "stored in one byte".
  - [SDK] The SDK generator (`com/gazt/einvoicing/qr/generation/service/impl/QRCodeGeneratorServiceImpl`) uses `com.payneteasy.tlv.BerTlvBuilder`, and the validator (`QrCodeValidator`) uses `BerTlvParser`. In that library's `fillLength`, a length `< 0x80` is 1 byte, `< 0x100` is `0x81 LL`, and `< 0x10000` is `0x82 HH LL` ([ber-tlv source](https://github.com/evsinev/ber-tlv/blob/master/src/main/java/com/payneteasy/tlv/BerTlvBuilder.java)).
  - **Values of 128 bytes or more therefore need BER long form.** Writing a single byte such as `0x90` would be read by ZATCA's BER parser as "16 length bytes follow".
  - The SDK samples never reach 128: tag 1 is 111, tag 7 is 96, tag 8 is 88, tag 9 is 71–72. But an Arabic seller name of about 64 characters or more does.
  - [COMMUNITY] Open bugs about exactly this: zatca-xml-js #61, salla/zatca #74, Saleh7/php-zatca-xml #38. The aashahin `zatca-sdk` switched to BER lengths in 2026-09.
  - Tags 1–9 fit in one BER tag byte.
- The final base64 must be ≤ 1000 characters (BR-CL-KSA-14). S-SEC/S-DTG mention "up to 700 characters" (SDK 3.0.9 raised its limit from 500 to 700). The validator in 3.4.8 enforces 1000.
- QR image error-correction level and size: not specified by ZATCA (**UNVERIFIED**). Encode the base64 string as text in byte mode.

### 5.2 Tags
[SDK-VERIFIED] using `Simplified_Invoice.xml` and `Standard_Invoice.xml`.

| Tag | Content | Exact value / encoding | Simplified | Standard |
|---|---|---|---|---|
| 1 | Seller name | UTF-8 of `AccountingSupplierParty/…/PartyLegalEntity/cbc:RegistrationName` | ✔ | ✔ |
| 2 | Seller VAT number | UTF-8 of `…/PartyTaxScheme/cbc:CompanyID` (15 ASCII digits) | ✔ | ✔ |
| 3 | Timestamp | `cbc:IssueDate` + `T` + `cbc:IssueTime`, exactly as written in the XML, e.g. `2022-08-17T17:41:08`, or `…Z` if IssueTime has a Z. SDK 3.2.6: "match the timestamp in QR Code with the Invoice Issue time (KSA-25) in XML allowing local time and Zulu time formats". [COMMUNITY] Adding a `Z`, or milliseconds, that IssueTime lacks gives `invoiceTimeStamp_QRCODE_INVALID`. | ✔ | ✔ |
| 4 | Invoice total with VAT | The **literal XML text** of `cbc:TaxInclusiveAmount` (BT-112). See §5.3 for the prepayment and rounding case, where it is `cbc:PayableAmount`. | ✔ | ✔ |
| 5 | VAT total | The **literal XML text** of the first `/Invoice/cac:TaxTotal/cbc:TaxAmount`. The standard sample has `0.6`, not `0.60`, because the XML says `0.6`. | ✔ | ✔ |
| 6 | Invoice hash | The **base64 string** of the invoice hash as ASCII bytes, **length 44** | ✔ | ✔ |
| 7 | ECDSA signature | The **base64 string** of `ds:SignatureValue` as ASCII bytes (≈96 bytes) | ✔ | ✔ |
| 8 | Public key | **Raw DER SubjectPublicKeyInfo** from the certificate, 88 bytes for secp256k1 (`3056301006072a8648ce3d020106052b8104000a034200 04…`) | ✔ | ✔ |
| 9 | Certificate signature | **Raw DER ECDSA signature** of the certificate: the `signatureValue` BIT STRING contents (without the 0x00 unused-bits byte), e.g. 71 bytes `3045022100b13f…` | ✔ | ✗ (absent from the standard sample and from ZATCA-cleared examples) |

Tags 6 and 7 hold base64 **text**, not raw bytes. S-SEC §4.1 says "[for tag 6] Length: length of hash (SHA256) is 32 bytes". The SDK samples and the S-DTG §6.2 worked example (tag 6 length 0x2c = 44, tag 7 0x60 = 96, tag 8 0x58 = 88, tag 9 0x48 = 72) all use base64 text for 6 and 7 and raw DER for 8 and 9. **Follow the SDK.**

### 5.3 Tag 4 and tag 5 corner cases
[SDK-VERIFIED] from the SDK samples. These are discrepancies; read carefully.

- **Tag 4:** in every SDK 3.4.8 sample where `TaxInclusiveAmount ≠ PayableAmount`, QR tag 4 holds **`PayableAmount`** (BT-115):
  - Advance Payment adjustments: tag 4 = `1035`; TaxInclusive `2185`; Payable `1035`.
  - Payable Rounding Adjustment: tag 4 = `1000.00`; TaxInclusive `1000.01`; Payable `1000.00`.

  The SDK class `InvoiceXmlXPath` references both `/Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount` and `/Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount`. S-DTG §6.2 says TaxInclusiveAmount. A forum report says that from SDK 3.3.0 tag 4 uses BT-115 when BT-113 or BT-114 is present, and that a mismatch yields warning `invoiceTotal_QRCODE_INVALID` [COMMUNITY, not confirmed]. **Recommendation:** tag 4 = `PayableAmount` text when `PrepaidAmount` or `PayableRoundingAmount` is present and non-zero, otherwise `TaxInclusiveAmount` text. They are equal in the normal case.
- **Tag 5:** the SDK reads `/Invoice/cac:TaxTotal/cbc:TaxAmount`, i.e. the **first** TaxTotal. In samples that is the SAR, no-subtotal one (BT-111):
  - USD export invoice: tag 5 = `00.0` (the SAR TaxTotal text), not the USD `00.00`;
  - USD prepayment sample: tag 5 = `1068.75` SAR, not `285` USD.

  S-SEC v1.2 says tag 5 = "Value provided in the business term id BT-110". For SAR invoices BT-110 = BT-111, so this only matters for foreign-currency invoices. Which one ZATCA's QR validator compares against is **UNVERIFIED**. Mirror the SDK: SAR TaxTotal first, and use its text.
- Use the XML **text** verbatim (`0.6` vs `0.60`) so the QR matches the XML exactly. Better still, always format amounts with exactly 2 decimals in the XML.

---

## 6. CSR (onboarding / renewal)

### 6.1 Fields
[OFFICIAL] S-SEC §2.2.2 Table 1, S-DTG §3.3.3, SDK `Data/Input/csr-config-*.properties`. [SDK-VERIFIED] ASN.1 of the official sample CSR in the COMPLIANCE_CSID swagger, decoded.

| SDK property | Where it goes in the CSR | ASN.1 type | Rule / example |
|---|---|---|---|
| `csr.common.name` | Subject `CN` | UTF8String | Free text: unique name or asset-tracking number of the EGS unit, e.g. `TST-886431145-399999999900003` |
| `csr.serial.number` | SAN dirName `SN` (surname, 2.5.4.4) | UTF8String | `1-<Manufacturer/Solution name>\|2-<Model or version>\|3-<Serial number>`, e.g. `1-TST\|2-TST\|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f` |
| `csr.organization.identifier` | SAN dirName `UID` (0.9.2342.19200300.100.1.1) | UTF8String | VAT or group VAT number: 15 digits, starting and ending with 3. If the **11th digit is 1**, it is a VAT group. |
| `csr.organization.unit.name` | Subject `OU` | UTF8String | Branch name. For VAT groups: the **10-digit TIN** of the member being onboarded. |
| `csr.organization.name` | Subject `O` | UTF8String | Taxpayer name; Arabic allowed |
| `csr.country.name` | Subject `C` | PrintableString | `SA` (ISO 3166 alpha-2) |
| `csr.invoice.type` | SAN dirName `title` (2.5.4.12) | UTF8String | 4 digits, `TSCZ`: T = standard, S = simplified, C and Z for future use (send 0). Examples: `1000` (B2B only), `0100` (B2C only), `1100` (both). |
| `csr.location.address` | SAN dirName `registeredAddress` (2.5.4.26) | UTF8String | Branch address, preferably the Saudi National Address "short address" (e.g. `RRRD2929`), or a website for e-commerce |
| `csr.industry.business.category` | SAN dirName `businessCategory` (2.5.4.15) | UTF8String | Industry or sector, e.g. `Supply activities` |
| (environment) | Extension `1.3.6.1.4.1.311.20.2` (Microsoft certificateTemplateName), non-critical | **UTF8String** | See §6.2 |

- Subject RDN order in the official CSR: `C`, `OU`, `O`, `CN`. [SDK-VERIFIED]
- S-SEC Table 1 lists `organizationIdentifier (2.5.4.97)` for the VAT number. The official sample CSR and the issued certificates put the VAT number in **SAN `UID`** and have **no** 2.5.4.97 in the subject. Follow the sample.
- There is no keyUsage or basicConstraints in the CSR.
- Key: EC secp256k1. Signature: ecdsa-with-SHA256.
- The CSR must be PKCS#10, self-signed as proof of possession (S-SEC #7).
- S-DTG: "All CSR fields are mandatory".

### 6.2 Certificate template name per environment
| Environment | Template value | Evidence |
|---|---|---|
| Production (Fatoora `core`) | `ZATCA-Code-Signing` | [OFFICIAL] S-FPM §3 |
| Simulation | `PREZATCA-Code-Signing` | [OFFICIAL] S-FPM §3 |
| Developer-portal sandbox | `TSTZATCA-Code-Signing` | [SDK] All three strings appear in the SDK's `CsrGenerationService` class (SDK flags: default, `-sim`, `-nonprod`). [COMMUNITY] zatca-xml-js uses TSTZATCA for the sandbox. The official sandbox swagger's sample CSR itself carries `ZATCA-Code-Signing`, so the sandbox appears lenient (**UNVERIFIED**). |

The ASN.1 string type: S-FPM writes `ASN1:PRINTABLESTRING:ZATCA-Code-Signing`. The official sample CSR in the sandbox swagger is **UTF8String** (`0C 12 5A41…`), and the SDK builds it with BouncyCastle `DisplayText`. Use **UTF8String**. Whether PrintableString is also accepted is **UNVERIFIED**.

### 6.3 OpenSSL config
[SDK-VERIFIED] I ran this with OpenSSL 3.2.4. The resulting CSR's template extension and SAN extension are **byte-identical** to the official sample CSR (`0C125A415443412D436F64652D5369676E696E67` and `3081A2A4819F30819C313B3039…`), and the subject string types match.

```ini
# zatca-csr.cnf
oid_section = zatca_oids
[ zatca_oids ]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[ req ]
prompt             = no
utf8               = yes
string_mask        = utf8only
distinguished_name = dn
req_extensions     = v3_req

[ dn ]
C  = SA
OU = Riyadh Branch
O  = Maximum Speed Tech Supply LTD
CN = TST-886431145-399999999900003

[ v3_req ]
# TSTZATCA-Code-Signing (developer portal) | PREZATCA-Code-Signing (simulation) | ZATCA-Code-Signing (production)
certificateTemplateName = ASN1:UTF8String:ZATCA-Code-Signing
subjectAltName          = dirName:alt_names

[ alt_names ]
SN                = 1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f
UID               = 399999999900003
title             = 1100
registeredAddress = RRRD2929
businessCategory  = Supply activities
```
```sh
openssl ecparam -name secp256k1 -genkey -noout -out key.pem
openssl req -new -sha256 -key key.pem -config zatca-csr.cnf -out egs.csr
# API body: {"csr": base64(contents of egs.csr INCLUDING the -----BEGIN/END CERTIFICATE REQUEST----- lines)}
```

For a pure-TS implementation (no openssl), build the PKCS#10 with `@peculiar/x509` / `pkijs` / `asn1js`, using the OIDs above and secp256k1 signing (§4.1). Golden check: compare your extension DER with the hex above.

### 6.4 Submission encoding
[SDK-VERIFIED] The swagger example `csr` decodes to `-----BEGIN CERTIFICATE REQUEST-----\nMIICFTCC…`. The value is **base64 of the PEM text, armour included**, not base64 of the DER. The SDK without `-pem` writes this same base64 form.

---

## 7. Fatoora API

### 7.1 Environments and base URLs
| Environment | Base URL | Evidence |
|---|---|---|
| Developer Portal Integration Sandbox | `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal` | [OFFICIAL] S-OAS `servers`; S-PORTAL env-config |
| Simulation (taxpayer, pre-production) | `https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation` | [OFFICIAL] S-FPM §3.B |
| Production (core) | `https://gw-fatoora.zatca.gov.sa/e-invoicing/core` | [OFFICIAL] S-FPM §3.A |
| *Legacy sandbox (do not use)* | `https://gw-apic-gov.gazt.gov.sa/e-invoicing/developer-portal` | [COMMUNITY] hard-coded in zatca-xml-js |

The sandbox is open to anyone with dummy data. Simulation and production need real taxpayer OTPs generated in the matching portal: simulation OTP from the simulation portal, core OTP from the Fatoora portal. [OFFICIAL] S-DTG FAQ; [COMMUNITY] S-FORUM t/391.

### 7.2 Endpoints
[OFFICIAL] S-OAS (sandbox) and S-FPM (paths for simulation and core are identical).

| # | Purpose | Method + path | Auth | Required headers | Body |
|---|---|---|---|---|---|
| 1 | Compliance CSID (CCSID) | `POST /compliance` | none | `OTP: <6 digits>`, `Accept-Version: V2`, `Content-Type: application/json` | `{"csr":"<base64(PEM)>"}` |
| 2 | Compliance checks | `POST /compliance/invoices` | Basic CCSID | `Accept-Version: V2`, `Accept-Language: en\|ar` (optional) | `{"invoiceHash":"…","uuid":"…","invoice":"<base64(xml)>"}` |
| 3 | Production CSID (onboarding) | `POST /production/csids` | Basic CCSID | `Accept-Version: V2` | `{"compliance_request_id":"<requestID from #1>"}` |
| 4 | Production CSID renewal | `PATCH /production/csids` | Basic **current PCSID** | `OTP`, `Accept-Version: V2`, `accept-language` | `{"csr":"<base64(PEM)>"}` |
| 5 | Reporting (simplified docs) | `POST /invoices/reporting/single` | Basic PCSID | `Accept-Version: V2`, `Clearance-Status: 0\|1` (marked *required* in the sandbox spec), `Accept-Language` | `{"invoiceHash","uuid","invoice"}` |
| 6 | Clearance (standard docs) | `POST /invoices/clearance/single` | Basic PCSID | `Accept-Version: V2`, `Clearance-Status: 1`, `Accept-Language` | `{"invoiceHash","uuid","invoice"}` |

- `Clearance-Status`: "Specifies the clearance status, while "0" when clearance is disabled and "1" when clearance is enabled". [OFFICIAL] S-OAS. Send `1` to clearance. For reporting, zatca-xml-js sends `0` [COMMUNITY]; production behaviour without the header is **UNVERIFIED**.
- `Accept-Version`: "V2 is currently the only valid version". [OFFICIAL] S-DPM. Anything else returns **406** with the text body `This Version is not supported or not provided in the header.`
- `invoice` = base64 of the **entire XML file** (UTF-8, including `<?xml …?>`). `invoiceHash` = §3 value. `uuid` = `cbc:UUID`. (The S-OAS schema `InvoiceRequest` omits `uuid` but every example includes it.)

### 7.3 Authentication
[OFFICIAL] S-SEC §5, S-DPM §3.
- `Authorization: Basic base64( binarySecurityToken + ":" + secret )`.
- The username is the `binarySecurityToken` **string exactly as returned** by #1, #3 or #4.

[SDK-VERIFIED] `binarySecurityToken` is base64 of the certificate's base64 text. Decoding it once yields `MIID…`, which is the value for `ds:X509Certificate` and the input for the CertDigest. Decoding twice yields DER. The sandbox swagger's dummy production token decodes to the very certificate in `Data/Certificates/cert.pem`.

Dummy sandbox credentials are published in S-OAS `components.securitySchemes.BasicAuth.description`:
- **CCSID** (for `/compliance/invoices` and `/production/csids`):
  - username = `TUlJQ1BUQ0NBZU9nQXdJQkFnSUdBWXp6Z0VoTk1Bb0dDQ3FHU000OUJBTUNNQlV4RXpBUkJnTlZCQU1NQ21WSmJuWnZhV05wYm1jd0hoY05NalF3TVRFd01UTXhNVFUwV2hjTk1qa3dNVEE1TWpFd01EQXdXakIxTVFzd0NRWURWUVFHRXdKVFFURVdNQlFHQTFVRUN3d05VbWw1WVdSb0lFSnlZVzVqYURFbU1DUUdBMVVFQ2d3ZFRXRjRhVzExYlNCVGNHVmxaQ0JVWldOb0lGTjFjSEJzZVNCTVZFUXhKakFrQmdOVkJBTU1IVlJUVkMwNE9EWTBNekV4TkRVdE16azVPVGs1T1RrNU9UQXdNREF6TUZZd0VBWUhLb1pJemowQ0FRWUZLNEVFQUFvRFFnQUVvV0NLYTBTYTlGSUVyVE92MHVBa0MxVklLWHhVOW5QcHgydmxmNHloTWVqeThjMDJYSmJsRHE3dFB5ZG84bXEwYWhPTW1Obzhnd25pN1h0MUtUOVVlS09Cd1RDQnZqQU1CZ05WSFJNQkFmOEVBakFBTUlHdEJnTlZIUkVFZ2FVd2dhS2tnWjh3Z1p3eE96QTVCZ05WQkFRTU1qRXRWRk5VZkRJdFZGTlVmRE10WldReU1tWXhaRGd0WlRaaE1pMHhNVEU0TFRsaU5UZ3RaRGxoT0dZeE1XVTBORFZtTVI4d0hRWUtDWkltaVpQeUxHUUJBUXdQTXprNU9UazVPVGs1T1RBd01EQXpNUTB3Q3dZRFZRUU1EQVF4TVRBd01SRXdEd1lEVlFRYURBaFNVbEpFTWpreU9URWFNQmdHQTFVRUR3d1JVM1Z3Y0d4NUlHRmpkR2wyYVhScFpYTXdDZ1lJS29aSXpqMEVBd0lEU0FBd1JRSWhBSUY4akljeHp2Q3lxVURUcDVPbXY3MlVweFBBTG1vUnl0OURZMjRqV21CUUFpQTBiYVo2WXJwcDV5SjRhaG9vb1czK09hOGtrYjMxZXZBb0hkdmdEODA2M3c9PQ==`
  - password = `PKoGsSwpPx236yNS7CWDojV4doe1i0W+5mPodbMEW5k=`
- **PCSID** (for reporting and clearance): username = the token in `REPORTING.openapi.json` (begins `TUlJRDNqQ0NBNFNnQXdJQkFnSVRFUUFBT0FQRjkw…`), password = `CkYsEXfV8c1gFHAtFWoZv73pGMvh/Qyo4LzKM2h/8Hg=`.
- Whether these still work against the live sandbox is **UNVERIFIED**; I did not call any API.

### 7.4 Sandbox OTP
[OFFICIAL] S-OAS:
- `POST /compliance` OTP examples: **valid `123345`**, invalid `111111`, expired `222222`.
- `PATCH /production/csids` OTP examples: **valid `123456`**, invalid `111111`, expired `222222`.

Real OTPs (simulation and production) are 6 numeric digits, valid for **1 hour**, and generated in batches of up to 100 per request on the Fatoora portal. There is no OTP API. [OFFICIAL] S-DTG §3.3.2 and FAQ.

### 7.5 Onboarding flow
[OFFICIAL] S-DTG §3.3.3–3.3.5, S-DPM §2.3.10.

1. Generate the key and CSR (§6), then `POST /compliance` with the OTP. The response contains `binarySecurityToken` (CCSID), `secret` and `requestID`.
2. Run compliance checks with `POST /compliance/invoices`, authenticated with the CCSID, for each document type the CSR's `title` declares:
   - `1000` → standard invoice, standard debit note, standard credit note (3 documents);
   - `0100` → simplified invoice, simplified debit note, simplified credit note (3 documents);
   - `1100` → all 6. [COMMUNITY] Many implementations send all 6 for 1100; consistent with the rule above.
   - The documents must be signed with the **CCSID** certificate. The simplified ones need QR + stamp.
3. `POST /production/csids` with `{"compliance_request_id": requestID}`, authenticated with the CCSID. The response contains the PCSID token and secret.
4. Use the PCSID for reporting and clearance, and to sign simplified documents.

Renewal: `PATCH /production/csids` with a new CSR and OTP, authenticated with the current PCSID. A **428** response with `dispositionMessage: "NOT_COMPLIANT"` returns a compliance certificate; run the compliance checks with it, then call `/production/csids` again. [OFFICIAL] S-OAS RENEWAL.

### 7.6 Responses

**CSID endpoints (200)** [OFFICIAL] S-OAS:
```json
{"requestID": 1234567890123, "dispositionMessage": "ISSUED",
 "binarySecurityToken": "TUlJQ1BU…", "secret": "Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw="}
```
Renewal adds `"tokenType": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"`.

**CSID errors:**

| Status | Body |
|---|---|
| 400 | `{"errors":[{"code":"…","message":"…"}]}` |
| 401 | `{"timestamp":…,"status":401,"error":"Unauthorized","message":""}` |
| 406 | Plain string |
| 500 | `{"code":"Invalid-Request","message":"System failed to process your request"}` or `{"category":"HTTP-Errors","code":"500","message":"Something went wrong and caused an Internal Server Error."}` |

CSID error codes:

| Code | Endpoint |
|---|---|
| `Missing-OTP`, `Invalid-OTP` ("The provided OTP is invalid") | `/compliance` and renewal |
| `Missing-CSR`, `Invalid-CSR` | `/compliance` and renewal |
| `Missing-ComplianceSteps` ("Compliance steps for this CSID are not yet complete") | `/production/csids` |
| `Missing-CurrentCCSID`, `Invalid-CurrentCCSID` | `/production/csids` |
| `Missing-compliance_request_id`, `Invalid-ComplianceRequestId` | `/production/csids` |
| `Missing-currentCSID`, `Invalid-currentCSID` | Renewal |

**Invoice endpoints** use `InvoiceResultModel` / `ClearedInvoiceResultModel` [OFFICIAL] S-OAS:
```json
{
  "validationResults": {
    "infoMessages":    [{"type":"INFO","code":"XSD_ZATCA_VALID","category":"XSD validation","message":"Complied with UBL 2.1 standards in line with ZATCA specifications","status":"PASS"}],
    "warningMessages": [{"type":"WARNING","code":"BR-KSA-98","category":"KSA","message":"[BR-KSA-98] - The simplified invoice should be submitted within 24 hours of issuing the invoice.","status":"WARNING"}],
    "errorMessages":   [],
    "status": "WARNING"
  },
  "reportingStatus": "REPORTED"
}
```
- Clearance responses carry `"clearanceStatus": "CLEARED" | "NOT_CLEARED"` and `"clearedInvoice": "<base64 xml>" | null` instead of `reportingStatus`.
- Compliance-check responses carry `reportingStatus`, `clearanceStatus`, and `qrSellertStatus` / `qrBuyertStatus`. Those two names are misspelt in the official spec; parse them as-is.
- `validationResults.status` is `PASS`, `WARNING` or `ERROR`. `category` values seen: `XSD validation`, `KSA`, `EN_16931`, `QRCODE_VALIDATION`, `INVOICE_HASHING_ERRORS`, `SIGNATURE_ERRORS`, `Invalid-InvoiceHash`.
- The spec's JSON Schema misspells `erroMessages`; real payloads use `errorMessages`. [OFFICIAL] (the typo is in S-OAS)
- Message arrays may be an object instead of an array in some examples (`infoMessages` in the COMPLIANCE_INVOICE example). Parse defensively.
- Some compliance-invoice 400 examples use an **older format**: `{"invoiceHash":"…","status":"Not Reported","warnings":null,"errors":[{"category":"Signature-Errors","code":"Signature-Value","message":"Wrong Signature Value"}]}`. Support both shapes.

**HTTP status semantics** [OFFICIAL] S-OAS:

| Status | Reporting | Clearance |
|---|---|---|
| 200 | REPORTED, no warnings | CLEARED (+ `clearedInvoice`) |
| 202 | REPORTED with warnings | CLEARED with warnings |
| 208 | — | "Invoice Hash Previously Submitted" (returns CLEARED + `clearedInvoice`) |
| 303 | — | Clearance deactivated: `{"message":"Clearance is deactiviated. Please use the /invoices/reporting/single endpoint instead."}` |
| 400 | NOT_REPORTED (errors) | NOT_CLEARED (errors) |
| 401 | Bad or missing Basic credentials | same |
| 406 | Bad or missing `Accept-Version` | same |
| 409 | "Invoice was already Reported successfully earlier." | — |
| 500 | Server error | same |

Timeouts, rate limits and retry semantics: not documented (**UNVERIFIED**). Make submissions idempotent by UUID and hash; ZATCA "will consider the Invoice only once based on unique identifiers such as UUID and hash" [OFFICIAL] S-DTG FAQ.

**Live-behaviour reports that differ from the swagger** [COMMUNITY]. Mostly from the zatca-kit README "traps" (https://github.com/Erpflow-dev/zatca-kit#the-traps-all-hit-live-all-handled-here); none independently verified:

| Report | What it means for the client |
|---|---|
| Renewal or compliance `NOT_COMPLIANT` can arrive with **HTTP 200**, not only 428 | Branch on `dispositionMessage`, not on status alone |
| Reporting **409** = already reported | Treat as success / idempotent |
| A duplicate clearance reply may lack `clearedInvoice` (swagger 208 shows it present) | Persist the first `clearedInvoice` |
| The live service returns `errorMessages`, not the swagger's `erroMessages` | Accept both spellings |
| `Accept-Version` must be exactly `V2` (capital V); otherwise 406 | |
| Re-encoding the token in the Basic username gives 401 | Use `binarySecurityToken` verbatim |
| An OTP is consumed by its first use and lasts 60 minutes | Don't retry `/compliance` with the same OTP after a partial failure |
| The gateway can hang for minutes | Use client timeouts of about 90 s plus retries with idempotency |
| `/compliance/invoices` fails browser CORS preflight (403) | The API client is server-side only |
| Simulation enforces the compliance-check gate (`Missing-ComplianceSteps`) | |
| 401/403 should be retried after refreshing credentials, not treated as an invoice rejection | ksa_compliance #372 |
| The official Java SDK needs **Java 11**: later JDKs removed secp256k1 from SunEC | lavaloon-eg/zatca-cli README; aashahin README |
| On Windows the SDK mis-hashes Arabic unless run with `-Dfile.encoding=UTF-8` | |

### 7.7 Clearance vs reporting rules
[OFFICIAL] S-DTG §4, S-BIZ §4.

- **Standard (B2B, subtype 01) → clearance, real time, before the invoice reaches the buyer.**
  - A standard document is valid only once it carries ZATCA's clearance stamp. Share the returned `clearedInvoice`.
  - If clearance fails (400), fix the problem and submit a *new* document: new UUID, ICV, hash and timestamp, with the date updated.
  - Self-billing standard documents are submitted by the buyer.
  - When clearance is switched off (303), submit standard documents to the reporting endpoint instead. They are then reported and not stamped.
- **Simplified (B2C, subtype 02) → reporting within 24 hours** of issuance.
  - The EGS signs and adds the QR. ZATCA does not stamp B2C.
  - BR-KSA-98 (warning) flags late submissions.
  - A rejected simplified invoice is fixed and resubmitted as a new document. The customer copy need not be reissued. Per one FAQ answer, a "NOT_REPORTED" invoice should be cancelled with a credit note and reissued; S-DTG gives both answers, so check current guidance.
- Re-submission of the identical document is not rejected as a duplicate by design (FAQ), but the sandbox returns 409 (reporting) and 208 (clearance).
- Incident reporting when the EGS cannot generate invoices: https://zatca.gov.sa/en/E-Invoicing/FailureNotifications/Pages/VerifyTaxpayer.aspx [OFFICIAL]

---

## 8. Business validation rules (for a friendly validator)

Source of truth: SDK 3.4.8 schematrons. `20210819_ZATCA_E-invoice_Validation_Rules.xsl` has 143 asserts (46 error, 97 warning); `CEN-EN16931-UBL.xsl` has 103. **"error" means rejection; "warning" means accepted with warnings.**

Severity in the SDK sometimes differs from S-XML v1.2 tables. For example, BR-KSA-37 is an error in the sandbox swagger example but a warning in the 3.4.8 XSL. Treat the XSL as current.

### 8.1 Most common failures, with a suggested friendly message
| Code | Sev. | Official message (abridged) | Friendly check / fix |
|---|---|---|---|
| BR-KSA-06 | error | KSA-2 must respect `NNPNESB` | `@name` must be 7 characters of 0/1 after `01` or `02`. Did you send `0100000` for standard and `0200000` for simplified? |
| BR-KSA-05 | error | BT-3 must be 388/383/381/386 | Use 388/381/383/386 only |
| BR-KSA-03 | error | UUID letters, digits, dashes only | Generate a v4 UUID |
| BR-KSA-04 | error | Issue date ≤ current date | Clock skew or timezone (KSA is UTC+3) |
| BR-KSA-70 | error | IssueTime must be `hh:mm:ss` or `hh:mm:ssZ` | No milliseconds, no offsets such as `+03:00` |
| BR-KSA-33 / 34 | error | ICV missing or not digits | `cac:AdditionalDocumentReference[ID=ICV]/cbc:UUID` digits only |
| BR-KSA-61 / 26 | warning | PIH missing or not base64 SHA-256 | Chain the previous document's hash; first = `NWZl…OQ==` |
| BR-KSA-68 / EN16931-02 | error | TaxCurrencyCode missing or not SAR | Always `<cbc:TaxCurrencyCode>SAR</…>` |
| BR-KSA-EN16931-01 | error | ProfileID must be `reporting:1.0` | |
| BR-KSA-EN16931-08 / 09 | warning | Exactly one TaxTotal with subtotals and one without | Two TaxTotals, §2.7 |
| BR-KSA-17 | error | Credit/debit note must contain reason KSA-10 | `cac:PaymentMeans/cbc:InstructionNote` |
| BR-KSA-56 | warning | Credit/debit note needs billing reference BT-25 | `cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID` |
| BR-KSA-F-04 | error | Amounts and quantities must be positive | No negative values in credit notes |
| BR-KSA-40 / 44 | error | VAT number is 15 digits, first and last `3` | Validate with the regex `^3\d{13}3$` |
| BR-CUSTOM-VALIDATION-01 | error | Seller VAT ≠ buyer VAT | |
| BR-KSA-08 | warning | Seller ID schemeID must be one of CRN/MOM/MLS/SAG/OTH/700, alphanumeric | |
| BR-KSA-14 | error | Buyer ID schemeID must be one of TIN/CRN/MOM/MLS/700/SAG/NAT/GCC/IQA/PAS/OTH, alphanumeric | |
| BR-KSA-81 | warning | Standard: buyer ID required when buyer VAT is absent | |
| BR-KSA-42 | warning | Standard: buyer name required | |
| BR-KSA-09 / 63 / 10 | warning | Address completeness (seller; SA buyer; foreign buyer) | |
| BR-KSA-37 | warning (swagger shows error) | Seller building number must be 4 digits | `^\d{4}$` |
| BR-KSA-66 / 67 | warning | Postal code must be 5 digits | `^\d{5}$` |
| BR-KSA-15 | warning | Standard 388 must have supply date KSA-5 | `cac:Delivery/cbc:ActualDeliveryDate` |
| BR-KSA-18 | error | VAT category must be S/Z/E/O | |
| BR-KSA-84 | error | Standard-rated rate must be 15 or 5 | |
| BR-KSA-CL-04 / 23 / 24 / 69 / 83 | warning | Z/E/O need a VATEX code (valid for the category) and a reason text | §2.8 table |
| BR-KSA-DEC-02 | error | VAT rates 0.00–100.00, at most 2 decimals | |
| BR-KSA-52 / 53 | error | Standard: line VAT (KSA-11) and line amount incl. VAT (KSA-12) mandatory | Line `cac:TaxTotal/TaxAmount` and `RoundingAmount` |
| BR-KSA-51 | warning | KSA-12 = BT-131 + KSA-11 | |
| BR-CO-15 | error | BT-112 = BT-109 + BT-110 | |
| BR-CO-14 | error | BT-110 = Σ BT-117 | |
| BR-CO-17 / BR-S-09 | warning | BT-117 = round2(BT-116 × rate/100) | Compute per category, half-up |
| BR-CO-10 / 13 / 16 | warning | Total consistency | |
| BR-KSA-EN16931-11 | warning | Line net = qty × (price / baseQty) + charges − allowances | |
| BR-KSA-EN16931-06 | error | No price-level charges (`ChargeIndicator` must be false) | |
| BR-KSA-98 | warning | Simplified must be submitted within 24 h | |
| BR-KSA-60 | warning | Simplified must carry the cryptographic stamp | |
| BR-KSA-27 | warning | QR must exist and be base64 | |
| BR-KSA-28 / 30 | error | Signature IDs / method literals | §4.2 |
| BR-KSA-31 | error | No self-billing on simplified | |
| BR-KSA-92 | error | B2G (KSA-2 pos 9) needs Contract ID | |
| BR-KSA-97 | warning | Non-SAR: BT-110 ≠ BT-111 | |
| BR-KSA-F-06-Cxx | mostly warning | Field length limits (see S-DD "maximum limit" column) | Most free-text fields ≤1000 or ≤127 characters; invoice line ID ≤6; billing reference ≤5000 (error) |

### 8.2 EN 16931 rules still active and fatal (error) in 3.4.8
[SDK] `CEN-EN16931-UBL.xsl`

| Rule | Requirement |
|---|---|
| BR-03 | Issue date |
| BR-04 | Type code |
| BR-05 | Currency |
| BR-14 | Total with VAT |
| BR-15 | Amount due |
| BR-16 | At least one line |
| BR-22 | Line quantity |
| BR-24 | Line net amount |
| BR-26 | Line net price |
| BR-54, BR-55 | Item attributes; preceding invoice reference |
| BR-CL-01/03/04/05/18 | Code lists |
| BR-CO-11/12/14/15/18 | Totals; at least one VAT breakdown |
| BR-E-05/06/07/09 | Exempt category rates and tax |
| BR-Z-05/06/07/09 | Zero-rated category rates and tax |
| BR-O-09 | Out-of-scope category tax = 0 |
| BR-S-06 | Standard-rated allowance rate > 0 |

### 8.3 Platform-level error codes (not schematron)
[OFFICIAL] S-OAS.

| Code | Category | Meaning / likely cause |
|---|---|---|
| `invalid-invoice-hash` | INVOICE_HASHING_ERRORS | "The invoice hash API body does not match the (calculated) Hash of the XML". Whitespace removal or C14N mistake, pretty-printing after hashing, or the wrong document. |
| `InvoiceHash-Errors` | Invalid-InvoiceHash | Hash missing ("Document hash is not present in the API body") or not valid base64 ("Document hash format in the API body is not valid") |
| `invoiceHash_QRCODE_INVALID` | QRCODE_VALIDATION | QR tag 6 ≠ document hash |
| `QRCODE_INVALID` | QRCODE_VALIDATION | "Failed to validate QR code" / "Invalid QR code format, Please follow the ZATCA QR code specifications" (missing QR, bad TLV) |
| `invalid-digital-signature` | SIGNATURE_ERRORS | ECDSA does not verify (signed the wrong bytes, or a key/certificate mismatch) |
| `XSD_ZATCA_INVALID` | XSD validation | Element order, missing mandatory UBL child, malformed XML. The message includes the SAX line and column. |
| Old format: `Signature-Value`, `Signing-Certificate-Digest-Value`, `xades-Signed-Properties-Digest-Value`, `X-509-Issuer-Name`, `X509-Serial-Number`, `Certificate` | Signature-Errors | One per signature component; maps 1:1 to §4.3/§4.4 |
| Old format: `Seller-Name`, `QR-Hashed-XML`, `Missing-QR-Code` | QR-Code-Errors | |
| Old format: `Missing-Signature` | Signature-Errors | |
| Old format: `Invalid-Authentication-Certificate`, `Missing-Authentication-Certificate` | Authentication-Errors | Auth header problems |
| `invoiceTotal_QRCODE_INVALID` | — | [COMMUNITY] Tag 4 vs BT-115 mismatch (warning) |
| `invoiceTimeStamp_QRCODE_INVALID` | — | [COMMUNITY] Tag 3 ≠ IssueDate`T`IssueTime (e.g. an extra `Z`) |
| Denied by Policy Module `0x80094800` "…certificate template … not supported" | (CSID issuance) | [COMMUNITY] Wrong `certificateTemplateName` for the environment (ERPGulf/zatca_erpgulf #74) |

### 8.4 Appendix A: full list of KSA rules in SDK 3.4.8
| Rule | Severity (SDK 3.4.8) | Message (verbatim, truncated at 400 chars) |
|---|---|---|
| BR-KSA-03 | error | The invoice must contain a unique identifier ("UUID") (KSA-1) given by the unit that issued the document (unique message identifier for interchange process). This value must contain only letters, digits, and dashes. |
| BR-KSA-04 | error | The document issue date (BT-2) must be less or equal to the current date. |
| BR-KSA-05 | error | The invoice type code (BT-3) must be equal to one of value from the subset of UN/CEFACT code list 1001, D.16B agreed for KSA electronic invoices. Please refer paragraph 11.2.1 of XML implementation Standards. |
| BR-KSA-06 | error | The invoice transaction code (KSA-2) must exist and respect the following structure: NNPNESBCG where NN (positions 1 and 2) = invoice subtype: - 01 for tax invoice - 02 for simplified tax invoice P (position 3) = 3rd Party invoice transaction, 0 for false, 1 for true; N (position 4) = Nominal invoice transaction, 0 for false, 1 for true; E (position 5) = Exports invoice transaction, 0 for false, 1 … |
| BR-KSA-07 | error | Self billing is not allowed (KSA-2, position 7 cannot be "1") for export invoices (KSA-2, position 5 = 1). |
| BR-KSA-08 | warning | The seller identification (BT-29) must exist only once with one of the scheme ID (BT-29-1) (CRN, MOM, MLS, SAG, OTH, 700) and must contain only alphanumeric characters. Commercial Registration number with "CRN" as schemeID. MOMRAH license with "MOM" as schemeID. MHRSD license with "MLS" as schemeID. 700 Number with "700" as schemeID. MISA license with "SAG" as schemeID. Other OD with "OTH" as sche … |
| BR-KSA-09 | warning | Seller address must contain street name (BT-35), building number (KSA-17), postal code (BT-38), city (BT-37), district (KSA-3), country code (BT-40). For more information please access this link: https://splonline.com.sa/en/national-address-1/ |
| BR-KSA-10 | warning | Where the Buyer Country Code (BT-55) is other than 'SA' Buyer address must contain a street (BT-50), city (BT-52), country code (BT-55). This rule does not apply on the simplified tax invoices and associated credit notes and debit notes (KSA-2, position 1 and 2 = 02). |
| BR-KSA-11 | error | An Invoice line (BG-25) where the VAT category code (BT-151) is "Not subject to VAT", an invoiced item VAT rate (BT-152) shall be 0 (zero), if exist. |
| BR-KSA-12 | warning | A Document level allowance (BG-20) where VAT category code (BT-95) is "Not subject to VAT", a Document level allowance VAT rate (BT-96) shall be 0 (Zero), if exist. |
| BR-KSA-13 | warning | A Document level charge (BG-21) where the VAT category code (BT-102) is "Not subject to VAT", a Document level charge VAT rate (BT-103) shall be 0 (zero), if exist. |
| BR-KSA-14 | error | The buyer identification (BT-46), required only if buyer is not VAT registered, then the buyer identification (BT-46) must be provided with one of the scheme IDs (BT-46-1) (TIN, CRN, MOM, MLS, 700, SAG, NAT, GCC, IQA, PAS, OTH) and must contain only alphanumeric characters. Tax Identification Number "TIN" as schemeID ;Commercial registration number with "CRN" as schemeID ;MOMRAH license with "MOM" … |
| BR-KSA-15 | warning | The tax invoice ((invoice type code (BT-30) = 388) and (invoice transaction code (KSA-2) has "01" as first 2 digits)) must contain the supply date (KSA-5). |
| BR-KSA-16 | warning | Payment means code (BT-81) in an invoice exist, then it must contain one of the values from subset of UNTDID 4461 code list |
| BR-KSA-17 | error | Debit and credit note (invoice type code (BT-3) is equal to 383 or 381) must contain the reason (KSA-10) for this invoice type issuing. |
| BR-KSA-18 | error | VAT category code must contain one of the values (S, Z, E, O). |
| BR-KSA-19 | warning | Each Document level charge (BG-21) shall have a code for the reason for document level charge (BT-105). |
| BR-KSA-20 | warning | Each Invoice line charge (BG-28) shall have a code for the reason for invoice line charge (BT-145). |
| BR-KSA-21 | warning | Each Document level charge (BG-21) shall have a Reason for document level charge (BT-104). |
| BR-KSA-22 | warning | Each Invoice line charge (BG-28) shall have a Reason for invoice line charge (BT-144). |
| BR-KSA-23 | warning | A VAT breakdown (BG-23) with VAT Category code (BT-118) 'Exempt from VAT' shall have a VAT exemption reason code (BT-121). |
| BR-KSA-24 | warning | A VAT breakdown (BG-23) with VAT Category code (BT-118) 'Not subject to VAT' shall have a VAT exception reason code (BT-121) |
| BR-KSA-25 | warning | If it is a simplified tax invoice or an associated credit note or a debit note (KSA-2, position 1 and 2 = 02) and the tax exemption reason code (BT-121) is equal with VATEX-SA-EDU or VATEX-SA-HEA, then buyer name (BT-44) is mandatory. |
| BR-KSA-26 | warning | If the invoice contains the previous invoice hash (KSA-13), this hash must be base64 encoded SHA256. The hash shall be computed using the following method as described in the ds:transforms block in the XML Invoice Specifications: 1. Remove the <Invoice><ext:UBLExtensions/> block 2. Remove the <Invoice><cac:AdditionalDocumentReference/> block where <cbc:ID/> = QR 3. Remove the <Invoice><cac:Signatu … |
| BR-KSA-27 | warning | The document must contain a QR code (KSA-14), and this code must be base64Binary. |
| BR-KSA-28 | error | If the cryptographic stamp (KSA-15) exists in the invoice, this cryptographic stamp (KSA-15) must contain the exact "urn:oasis:names:specification:ubl:signature:1" value for signature information ID. |
| BR-KSA-29 | warning | If the cryptographic stamp (KSA-15) exists in the invoice, this cryptographic stamp (KSA-15) must contain the exact "urn:oasis:names:specification:ubl:signature:Invoice" value for referenced signature ID and signature ID. |
| BR-KSA-30 | error | The document cryptographic stamp (KSA-15) must contain the exact "urn:oasis:names:specification:ubl:dsig:enveloped:xades" value for signature method. |
| BR-KSA-31 | error | For Simplified Tax Invoices and associated credit notes and debit notes (KSA-2, position 1 and 2 = 02), transaction types "self-billing" (KSA-2, position 7 = True) is not allowed. |
| BR-KSA-33 | error | Each invoice must have an invoice counter value (KSA-16). |
| BR-KSA-34 | error | The invoice counter value (KSA-16) contains only digits. |
| BR-KSA-35 | warning | If the invoice contains a supply end date (KSA-24), then the invoice must contain a supply date (KSA-5). |
| BR-KSA-36 | warning | If the invoice contains a supply end date (KSA-24), then this date must be greater than or equal to the supply date (KSA-5). |
| BR-KSA-37 | warning | The seller address building number must contain 4 digits. |
| BR-KSA-39 | error | The invoice must contain the seller VAT registration number or seller group VAT registration number (BT-31). |
| BR-KSA-40 | error | If it exists in the invoice, the seller VAT registration number (BT-31) must contain 15 digits. The first and the last digits are "3".. |
| BR-KSA-42 | warning | The buyer name (BT-44) must be present in the tax invoice and associated credit notes and debit notes (KSA-2, position 1 and 2 = 01). |
| BR-KSA-44 | error | If it exists in the invoice,the buyer VAT registration number or buyer group VAT registration number (BT-48) must contain 15 digits. The first digit and the last digit is "3". |
| BR-KSA-49 | error | If the tax exemption reason code (BT-121) is equal to VATEX-SA-EDU or VATEX-SA-HEA, then the other buyer ID (BT-46) is mandatory and must be national ID (BT-46-1 = NAT). |
| BR-KSA-51 | warning | The line amount with VAT (KSA-12) must be Invoice line net amount (BT-131) + Line VAT amount (KSA-11). |
| BR-KSA-52 | error | The line VAT amount (KSA-11) is mandatory for tax invoice and associated credit notes and debit notes (KSA-2, position 1 and 2 = 01). |
| BR-KSA-53 | error | The line amount with VAT (KSA-12) is mandatory for tax invoice and associated credit notes and debit notes (KSA-2, position 1 and 2 = 01). |
| BR-KSA-56 | warning | For credit notes ((BT-3) has the value of 381) and debit notes ((BT-3) has the value of 383), the billing reference ID (BT-25) is mandatory. |
| BR-KSA-60 | warning | Cryptographic stamp (KSA-15) must exist in simplified tax invoices and associated credit notes and debit notes (KSA-2, position 1 and 2 = 02). |
| BR-KSA-61 | warning | Previous invoice hash (KSA-13) must exist in an invoice. |
| BR-KSA-63 | warning | If the buyer country code (BT-55) is "SA", then these fields are mandatory:street name (BT-50), building number (KSA-18), postal code (BT-53), city (BT-52), District (KSA-4), country code (BT-55).For more information please access this link:https://splonline.com.sa/en/national-address-1/ |
| BR-KSA-66 | warning | Seller postal code (BT-38) must be 5 digits. |
| BR-KSA-67 | warning | If the buyer country code (BT-55) is "SA", then the Buyer postal code(BT-53) must be 5 digits. |
| BR-KSA-68 | error | Tax currency code (BT-6) must exist in an invoice. |
| BR-KSA-69 | warning | A VAT breakdown (BG-23) with VAT Category code (BT-118) 'Zero rated' shall have a VAT exception reason code (BT-121). |
| BR-KSA-70 | error | The invoice must contain Invoice Issue Time (KSA-25). This value should be in the format: hh:mm:ss for time expressed in local time (eg 19:20:30) or hh:mm:ssZ for time expressed in UTC (eg 19:20:30Z)."The invoice must contain Invoice Issue Time (KSA-25). This value should be in the format: hh:mm:ss for time expressed in local time (eg 19:20:30) or hh:mm:ssZ for time expressed in UTC (eg 19:20:30Z) … |
| BR-KSA-71 | warning | If the Invoice is a simplified invoice type and is a summary invoice (KSA-2, position 1 and 2 = 02, position 6 = 1),then the buyer name must be present. |
| BR-KSA-72 | error | If the Invoice is a simplified invoice type and is a summary invoice (KSA-2, position 1 and 2 = 02, position 6 = 1), then a supply date (KSA-5) and supply end date (KSA-24) must be present |
| BR-KSA-73 | warning | If Pre-Paid amount (BT-113) is provided, then the following data is mandatory to provide as additional invoice line(s) -Prepayment ID (KSA-26) -Sequential invoice number (BT-1) of the prepayment invoice(s)-Prepayment Issue Date (KSA-28) -Issue date (BT-2) of the prepayment invoice(s) Prepayment Issue Time (KSA-29) - Issue time (KSA-25) of the prepayment invoice(s) Prepayment Document Type Code (KS … |
| BR-KSA-74 | error | Prepayment Document Type Code (KSA-30) for the Invoice line document reference must be '386'. |
| BR-KSA-75 | warning | If Prepayment Document Type code (KSA-30) is provided in an Invoice Line, then the following data is mandatory to provide in that invoice line - Prepayment VAT category Taxable Amount (KSA-31) - Sum total of taxable amounts subject to specific VAT Category code of the prepayment invoice(s); Prepayment VAT Category Tax Amount (KSA-32) - Sum total of tax amounts subject to specific VAT Category code … |
| BR-KSA-76 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is "Zero rated" the Prepayment VAT rate (KSA-34) shall be 0 (zero). |
| BR-KSA-77 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is "Exempt from VAT" the Prepayment VAT rate (KSA-34) shall be 0 (zero). |
| BR-KSA-78 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is "Not subject to VAT" the Prepayment VAT rate (KSA-34) shall be 0 (zero). |
| BR-KSA-79 | warning | The Prepayment VAT Category Tax Amount (KSA-32) must be Prepayment VAT category Taxable Amount( (KSA-31) x Prepayment VAT rate (KSA-34) /100). |
| BR-KSA-80 | warning | The Pre-Paid amount (BT-113) must be equal to the sum total of the Prepayment VAT category Taxable Amount (KSA-31) and the Prepayment VAT Category Tax Amount (KSA-32). |
| BR-KSA-81 | warning | The other Buyer ID (BT-46) must present in the tax invoice and associated debit notes and credit notes (KSA-2, position 1 and 2 = 01), where the buyer VAT registration number or buyer group VAT registration number (BT-48) is not provided. |
| BR-KSA-82 | error | An Invoice line (BG-25) where Prepayment Document Type Code (KSA-30) is provided, then Item net price (BT-146); Invoice line allowance amount (BT-136); Invoice line charge amount (BT-141); Item line net amount (BT-131); line VAT amount (KSA-11); and line amount with VAT (KSA-12) for that line shall be 0 (Zero), if exist. |
| BR-KSA-83 | warning | A VAT breakdown (BG-23) with VAT Category code (BT-118) 'Exempt from VAT' or 'Zero rated' or 'Not subject to VAT' shall have a VAT exemption (or exception) reason text (BT-120) with one of the values from paragraph 11.2.4 of XML implementation standards on Tax exemption (or exception) reason text - specific to Saudi Arabia. |
| BR-KSA-84 | error | The Document level allowance VAT rate (BT-96), Document level Charge VAT rate (BT-103), VAT category rate(BT-119), Invoiced item VAT rate (BT-152), Prepayment VAT rate(KSA-34) must be limited to one of the following values (5 or 15) when the relevant Document level allowance VAT category code (BT-95), Document level Charge VAT category code(BT-102), VAT category code(BT-118), Invoiced item VAT cat … |
| BR-KSA-85 | warning | The Buyer's contact phone number (BT-57) shall start with "0" or "+", followed by a maximum of 15 number and minimum 4 character after the "+" or "0" , if exist. |
| BR-KSA-87 | warning | If the tax exchange rate (KSA-36) exists, then Source Currency Code (KSA-37), Target Currency Code (KSA-38) and Calculation Rate (KSA-39) shall be provided |
| BR-KSA-88 | error | If exist, Source Currency Code (KSA-37) must be the same as Invoice currency code (BT-5) |
| BR-KSA-89 | error | If exists, Target Currency Code (KSA-38) must be the same as the Tax currency code (BT-6) |
| BR-KSA-90 | error | If exists, the allowed maximum number of digits for the Tax Exchange Rate (KSA-39) is 14. |
| BR-KSA-92 | error | If it's a B2G invoice transaction type (KSA 2, position 9 = 01), then the Contract ID (BT-12) must be present in a tax invoice and associated credit notes and debit notes (KSA-2, position 1 and 2 = 01). |
| BR-KSA-93 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is "Zero-rated" the Prepayment VAT exception reason code (KSA-41) should be provided. |
| BR-KSA-94 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is " Exempt from VAT " the Prepayment VAT exemption reason code (KSA-41) should be provided. |
| BR-KSA-95 | warning | An Invoice line (BG-25) where the Prepayment VAT category code (KSA-33) is " Not subject to VAT " the Prepayment VAT exception reason code (KSA-41) should be provided. |
| BR-KSA-96 | warning | An Invoice line (BG-25) with the Prepayment VAT category code (KSA-33) 'Exempt from VAT' or 'Zero rated' or 'Not subject to VAT' shall have a Prepayment VAT exemption(or exception) reason text (KSA-42) with one of the values from paragraph 11.2.4 of XML implementation standards on Tax exemption (or exception) reason text - specific to Saudi Arabia. |
| BR-KSA-97 | warning | If the Document Currency Code (BT-5) is different from "SAR", then the value in "Invoice total VAT amount (BT-110)" cannot be the same as the value in "Invoice total VAT amount in accounting currency (BT-111)". |
| BR-KSA-98 | warning | The simplified invoice should be submitted within 24 hours of issuing the invoice. |
| BR-KSA-99 | warning | If it exists in the invoice, the buyer VAT registration number or buyer group VAT registration number (BT-48) should not be left empty in the tax invoice and associated credit notes and debit notes (KSA-2, position 1 and 2 = 01). |
| BR-CL-KSA-14 | error | Field character limit for QR Code field has been exceeded. The maximum character limit for this field is 1000 characters. |
| BR-CUSTOM-VALIDATION-01 | error | The Seller VAT registration number or seller group VAT registration number (BT-31) of The invoice must not match the buyer VAT registration number (BT-48) . |
| BR-KSA-CL-01 | error | Currency code (BT-5) must be according to ISO 4217:2005 |
| BR-KSA-CL-02 | error | All currencyID attributes (BT-5) must have the same value as the invoice currency code (BT-5), except for the invoice total VAT amount in accounting currency (BT-111). |
| BR-KSA-CL-03 | error | Mime code must be according to subset of IANA code list. |
| BR-KSA-CL-04 | warning | If VAT category Code (BT-118) is 'Z', or 'E', VAT exemption (or exception) reason code (BT-121) must exist with one of the values from paragraph 11.2.4 of XML implementation standards on Tax exemption (or exception) reason code - specific to Saudi Arabia. |
| BR-KSA-CL-06 | warning | Code for the reason for document level charge (BT-105) and the code for the reason for invoice line charge (BT-145) MUST be coded using UNTDID 7161 code list. https://unece.org/fileadmin/DAM/trade/untdid/d16b/tred/tred7161.htm |
| BR-KSA-CL-07 | warning | If the Prepayment VAT Category Code(KSA-33) is 'Z', or 'E' or 'O', the Prepayment VAT exemption (or exception) reason code(KSA-41) must exist with one of the values from paragraph 11.2.4 of XML implementation standards on Tax exemption (or exception) reason code - specific to Saudi Arabia. |
| BR-KSA-DEC-01 | error | The allowance percentage values (BT-94, BT-138) must be from 0.00 to 100.00, with maximum two decimal places. Only numerals are accepted, the percentage symbol (%) is not allowed. |
| BR-KSA-DEC-02 | error | The VAT rates (BT-96, BT-103, BT-119, BT-152, KSA-34) must be from 0.00 to 100.00, with maximum two decimals.Only numerals are accepted, the percentage symbol (%) is not allowed. |
| BR-KSA-DEC-03 | warning | VAT amount at line level (KSA-11) must have a maximum two decimals. |
| BR-KSA-DEC-04 | warning | Amount with VAT at line level (KSA-12) must have a maximum two decimals. |
| BR-KSA-DEC-06 | warning | Prepayment VAT category Taxable Amount (KSA-31) and Prepayment VAT Category Tax Amount (KSA-32) must have a maximum two decimals. |
| BR-KSA-EN16931-01 | error | Business process (BT-23) must be "reporting:1.0". |
| BR-KSA-EN16931-02 | error | VAT accounting currency code (BT-6) must be "SAR". |
| BR-KSA-EN16931-03 | warning | Allowance/Charge amount (BT-92, BT-99, BT-136, BT-141) must equal base amount (BT-93, BT-100, BT-137, BT-142) * percentage (BT-94, BT-101, BT-138, BT-143) / 100 if base amount and percentage exists. |
| BR-KSA-EN16931-04 | warning | Allowance/Charge base amount (BT-93, BT-100, BT-137, BT-142) must be provided when allowance/Charge percentage (BT-94, BT-101,BT-138, BT-143) is provided. |
| BR-KSA-EN16931-05 | warning | Allowance/Charge percentage (BT-94, BT-101, BT-138, BT-143) must be provided when the allowance/Charge base amount (BT-93, BT-100, BT-137, BT-142) is provided. |
| BR-KSA-EN16931-06 | error | Charge on price level (BG-29) is not allowed. The value of Indicator should be 'false'. |
| BR-KSA-EN16931-07 | error | Item net price (BT-146) must equal (Item Gross price (BT-148) - Allowance amount (BT-147)) when gross price is provided. |
| BR-KSA-EN16931-08 | warning | Only one tax total (BG-22) with tax subtotals must be provided.Refer to Calculation of VAT. |
| BR-KSA-EN16931-09 | warning | Only one tax total (BG-22) without tax subtotals (BG-23) must be provided when tax currency code is provided . |
| BR-KSA-EN16931-11 | warning | Invoice line net amount (BT-131) must equal (Invoiced quantity (BT-129) * (Item net price (BT-146) / item price base quantity (BT-149))-) + Sum of invoice line charge amount (BT-141) - Sum of invoice line allowance amount (BT-136). |
| BR-KSA-EN16931-12 | error | Base quantity (BT-149) must be a positive number above zero. |
| BR-KSA-F-01 | error | A date MUST be formatted YYYY-MM-DD, in accordance to the "Calendar date complete representation" as specified by ISO 8601:2004, format YYYY-MM-DD. |
| BR-KSA-F-02 | error | Allowance/Charge Indicator value MUST equal to 'false'/’True’ respectively. |
| BR-KSA-F-04 | error | All the document amounts and quantities must be positive, unless specified otherwise. |
| BR-KSA-F-05 | warning | Prepayment Issue Time (KSA-29) must be in the format: hh:mm:ss for time expressed in local time or hh:mm:ssZ for time expressed in UTC.(eg 19:20:30) |
| BR-KSA-F-07 | warning | The value provided in Other Buyer ID (BT-46) for scheme ID 'TIN' appears to be incorrect. Please recheck the value to avoid non-compliance. |
| BR-KSA-F-08 | warning | The value provided in Other Seller ID (BT-29) or Other Buyer ID (BT-46) for the scheme ID 'CRN' appears to be incorrect. Please recheck the value to avoid non-compliance. |
| BR-KSA-F-09 | warning | The value provided in Other Seller ID (BT-29) or Other Buyer ID (BT-46) for the scheme ID '700' appears to be incorrect. Please recheck the value to avoid non-compliance. |
| BR-KSA-F-10 | warning | The value provided in Other Buyer ID (BT-46) for the scheme ID 'NAT' appears to be incorrect. Please recheck the value to avoid non-compliance. |
| BR-KSA-F-11 | warning | The value provided in Other Buyer ID (BT-46) for the scheme ID 'IQA' appears to be incorrect. Please recheck the value to avoid non-compliance. |
| BR-KSA-F-12 | warning | The Other Seller/Buyer schema ID (BT-29-1 or BT-46-1) contains spaces. Please recheck the attribute and remove the empty space to avoid non-compliance. |
| BR-KSA-F-13 | warning | Please recheck Other Seller/Buyer ID (BT-29 or BT-46) as it contains an invalid value. |

The 29 field-length rules `BR-KSA-F-06-C*` are omitted; the S-DD "Field character limits" column has the limits.

---

## 9. Rollout waves

- **Wave 25** [OFFICIAL] S-W25, dated 24 July 2026:
  - It covers all taxpayers whose revenues subject to VAT exceeded **SAR 187,500** in **2022, 2023, 2024 or 2025**.
  - ZATCA will notify them to integrate with Fatoora "by no later than **February 1, 2027**".
  - Advisers note this is the first wave to use calendar year 2025 revenue [COMMUNITY: EY https://www.ey.com/en_gl/technical/tax-alerts/saudi-arabia-announces-25th-wave-of-phase-2-e-invoicing-integration].
- **Wave 24**: threshold SAR 375,000, deadline 30 June 2026, so Wave 25 halves the threshold. [COMMUNITY: Grant Thornton https://www.grantthornton.sa/insights/articles-and-publications/ZATCA_announces_wave_25_of_e-Invoicing_in_saudi_arabia/ ; KPMG https://kpmg.com/sa/en/insights/tax-insights/announcement-of-25th-wave-for-e-invoicing-phase-2-implementation.html]. I did not check this against the ZATCA wave 24 announcement (**UNVERIFIED** at primary source).
- ZATCA notifies each wave at least six months before its deadline. [OFFICIAL] S-DTG §1.1
- **Market implication (inference, not verified at primary source here):** SAR 187,500 equals the KSA *voluntary* VAT-registration threshold; the mandatory threshold is SAR 375,000. Wave 25 therefore reaches most VAT-registered small businesses, a large population running POS and cloud invoicing apps that will need simplified-invoice signing and reporting.

---

## 10. Existing open-source libraries
Everything in this section is [COMMUNITY]. The survey was done on 2026-11-10 against GitHub and the npm, PyPI, Packagist, NuGet, pub.dev and crates registries plus MCP registries. Star counts and downloads are approximate. "dl/mo" = npm downloads for 2026-10-10 to 2026-11-08. Nothing was run against ZATCA.

### 10.1 JavaScript / TypeScript

**zatca-xml-js (wes4m)**
- https://github.com/wes4m/zatca-xml-js · npm `zatca-xml-js` · MIT · about 10.4k dl/mo, about 92 stars.
- **Stale:** last commit and release v0.1.9 were 2022-12-09.
- Coverage:
  - simplified invoices only;
  - XML by template-string replace;
  - hash, sign and QR;
  - CSR via an **openssl CLI spawn** that writes keys to `/tmp`;
  - API client for compliance, PCSID and reporting, but **no clearance**. Production URL is `"TODO"`; the base URL is the legacy `gw-apic-gov.gazt.gov.sa`.
- Pitfalls documented in code and issues:
  - invoice-hash whitespace hack;
  - cert hash = b64(hex(sha256(b64 text)));
  - separate "for signing" SignedProperties template plus `signedPropertiesIndentationFix`;
  - ECDSA over the hash bytes;
  - SigningTime is local time with a "Z";
  - #16: the hash only works with its own templates;
  - #44: SignedProperties hashing (39 comments);
  - #49: issuer name;
  - #14 / #30: Node ASN.1 "wrong tag";
  - **#61: single-byte TLV length breaks at 128 bytes or more**;
  - #62: invoice `cbc:UUID` reused.
- Dependencies: `xmldom@^0.6.0`, which has multiple high-severity advisories; `moment`; `axios@0.27`.

**Forks of zatca-xml-js** (all still spawn openssl and keep the whitespace hack):

| Fork | Notes |
|---|---|
| `zatca-xml-ts` (Repzo) | MIT, stale |
| `@jaicome/zatca-core` / `zatca-server` | MIT; Bun-only engines; **generates P-256 keys, not secp256k1** |
| `@pioneersoft/zatca-einvoice` | MIT; adds standard invoices, clearance and renewal |

**@axenda/zatca** — https://github.com/axenda/zatca · MIT · about 15.4k dl/mo · **Phase 1 QR only**, stale since 2021.

**@talha7k/zatca** — https://github.com/talha7k/zatca
- **AGPL-3.0**. Active (2026-10).
- TS-first, Effect v4; BigInt decimals; standard and simplified documents and notes; hand-rolled ASN.1 CSR; API client with clearance and retry; browser and HSM signer hook.
- No openssl CLI. Falls back to P-256 outside production for Bun.
- Differs from the SDK in two places: it **signs SignedInfo**, and maps the sandbox CSR template to `ZATCA-Code-Signing`.
- Vendors the official SDK 3.0.8 (LGPL).

**zatca-sdk (aashahin)** — https://github.com/aashahin/zatca-sdk
- **MIT**. New (2026-07), 1 star.
- **Pure JS crypto via `@noble/curves`, no openssl.**
- Coverage: XML, hash, sign, QR, CSR, API client for all three environments, `validateInvoice()`.
- Its README design notes match this spec: sign the hash bytes; cert digest of the base64 text as hex then base64; SignedProperties at 36-space indentation; **BER TLV lengths**; literal QR timestamp.
- Vendors SDK 3.4.8. Its README says the Java validator needs Java 11.

**zatca-kit (Erpflow-dev)** — https://github.com/Erpflow-dev/zatca-kit
- **AGPL-3.0**. **Not on npm** ("drop src/ in").
- `node:crypto` only, hand-rolled DER CSR, full API client, NestJS example.
- The best list of live-sandbox "traps"; see §7.6.

**@dokhna-tech/zatca** — https://github.com/dokhna/dokhna-tech-zatca
- **BUSL-1.1**: source-available, not OSI open source.
- All six document types, one-shot `onboard()`.
- README: other Node packages "had bugs that surfaced only against real ZATCA sandbox/production flows".

**Others:**
- `@khaledhajsalem/zatca-node`: MIT; needs OpenSSL for the CSR.
- `zatca-phase2`: its repository is 404.
- `zatca` (abdo-host): QR only despite its description.
- `@zatca/qr`: GPL, QR only.

**fatoority** — https://github.com/mqqz/fatoority
- Rust core with npm (WASM), PyPI, NuGet, crates and C FFI bindings. Apache-2.0 / MIT.
- Active.
- **The only JS-consumable package with offline validation of all business-rule assertions of SDK 238-R3.4.8**, via WASM and without Java.

**Is there a TS-first package without the openssl CLI?**
- Yes: `@talha7k/zatca` (AGPL), `zatca-sdk`/aashahin (MIT), `zatca-kit` (AGPL, not on npm), `@dokhna-tech/zatca` (BUSL).
- **No widely adopted, permissively licensed one.** The most-downloaded Phase 2 lineage still shells out to openssl.

### 10.2 Python

| Library | License | Status | Notes |
|---|---|---|---|
| **ksa_compliance** (LavaLoon, Frappe/ERPNext) https://github.com/lavaloon-eg/ksa_compliance | AGPL-3.0 | Active | Delegates crypto to the official Java SDK via `zatca-cli` (Kotlin, MIT), which needs **Java 11**. Issues: #343 exec format error on ARM; #331/#363/#288 BR-CO-14/15 rounding; #372 401/403 handling. |
| **zatca_erpgulf** (ERPGulf, Frappe) https://github.com/ERPGulf/zatca_erpgulf | MIT | Active | Pure Python (`cryptography` + lxml); b64(hexdigest) for cert and SignedProperties; an `adjust_indentation()` re-indent. Issues: #74 `PREZATCA-Code-Signing` "Denied by Policy Module 0x80094800"; #75/#79 "ECDSA Public Key does not match with qr code"; #8 QR too large for version 15. |
| zatca-tools-sdk | MIT | New | Links a hosted error reference |
| fatoora (TheAwiteb) | — | Archived | Phase 1 |
| django-zatca, qrzatca, fatoora-einvoice | | Small | Its repo is 404 |

There are **no** PyPI packages named `zatca-python`, `python-zatca` or `zatca-mcp`.

### 10.3 PHP

| Library | License | Status | Notes |
|---|---|---|---|
| **salla/zatca** https://github.com/SallaApp/ZATCA | MIT | Maintained (v4.0.1, 2026-09) | About 565k installs, the most-used library in any language. Phase 2 signing but **no API client**. Open issues: #74 single-byte TLV length; #59/#57/#50 hash mismatch; #52 SignedProperties hashing. |
| **saleh7/php-zatca-xml** https://github.com/Saleh7/php-zatca-xml | MIT | | CSR, XML, sign, QR, API. Issues: #19 SignedProperties hash fails on **Windows only** (line endings); #38 TLV length; #2 issuer/serial. |
| **sevaske/php-zatca-xml** + **sevaske/zatca-api** | MIT | | PSR-18 client. Issues: #9 `invoiceTimeStamp_QRCODE_INVALID`; #10 issuer/serial. |
| Laravel wrappers (corecave/laravel-zatca, sevaske/zatca, zid/zatca) | | | |

### 10.4 .NET, Ruby, Go, Dart

| Library | License | Notes |
|---|---|---|
| NuGet `Zatca.EInvoice.SDK` | **None stated** | Name matches ZATCA's own DLLs; provenance UNVERIFIED |
| `Zatca.Net` (SENESO) | MIT | New. The name collides with aljbri/Zatca.Net (LGPL-2.1, QR only). |
| `GeeSuthSoft.KSA.ZATCA` | None | |
| `Zatca.EInvoice` (mabumusa1) | Apache-2.0 | |
| Ruby `zatca` (mrsool) | MIT | Stale since 2023-12. `hacks.rb` hard-codes ZATCA's exact `QualifyingProperties` whitespace; openssl CLI for the CSR. |
| Go `zatca-sdk-go` (Haraj) | | QR only |
| Dart `zatca` (sbrsubuvga) | MIT | Phase 2 signing |

### 10.5 MCP servers (what exists)

| Server | What it is | Problems |
|---|---|---|
| **DoubleH10/zatca-mcp** (Python; LICENSE file Apache-2.0; on Glama and LobeHub; no PyPI package despite LobeHub's `pip install`) | 9 tools | By code inspection it **does not follow ZATCA's quirks**: cert digest b64(sha256(DER)); exclusive C14N; signs SignedInfo; CSR without template extension or SAN dirName; QR tags 1–8 only. Likely non-conformant. |
| **@saudi-mcp/zatca** (npm, MIT) | 5 API tools | Builds unsigned XML; hashes the raw XML string; ships a **corrupted genesis PIH** (`…NmU0NTJiODMz`) |
| **saudi-invoice-mcp** (remote `inv-sa.wishpool.app`) | Forwards already-signed XML | Glama shows it unhealthy; its GitHub repo returns 404 |
| saudi-vat-pro-mcp, com.simplefatoora/mcp, gcc-intelligence-mcp | Wrappers around commercial hosted services, or generic | No local signing |

The official MCP registry returns **0** results for "zatca". Smithery: UNVERIFIED (its API errored).

### 10.6 Gaps a new TypeScript library can fill (each backed by the evidence above)
1. **A permissive (MIT/Apache), pure-TS, runtime-portable secp256k1 signer and CSR builder**: no openssl CLI and no `/tmp` keys, using `@noble/curves`. WebCrypto lacks secp256k1, and Bun's `node:crypto` lacks it (oven-sh/bun#17184, open).
2. **One canonicalizer that handles arbitrary input XML** using the §3 rule (remove nodes, keep whitespace), instead of templates plus string patches.
3. **A published, byte-locked conformance suite.** §11 vectors plus all 19 SDK samples: hash, cert digest, SignedProperties digest, signature verification, QR decode, CSR extension DER.
4. **Correct BER-TLV QR lengths** (still broken in salla, Saleh7 and zatca-xml-js).
5. **Offline validation in JS without Java**: XSD plus a port of the BR-KSA and EN 16931 asserts (only fatoority, via WASM, does this today).
6. **A typed API client with normalized results**: 200/202/208/303/400/401/406/409/428; `NOT_COMPLIANT` on 200; both error formats; the `erroMessages` typo; timeouts and retries; idempotency.
7. **A friendly, bilingual BR-KSA error catalogue** (Appendix A gives every code and message).
8. **Maintained dependencies.** The popular lineage pins vulnerable `xmldom@0.6`, `moment` and old `axios`.
9. **Full document coverage**: standard, simplified, notes, prepayment, export, summary, B2G flags.
10. **An open-source, local, *conformant* ZATCA MCP server.** None exists.

---

## 11. Golden test vectors (from SDK 3.4.8 samples; all reproduced)

**Signing material** (`Data/Certificates/`):
- Private key `ec-secp256k1-priv-key.pem` (SEC1, base64, no armour): `MHQCAQEEIL14JV+5nr/sE8Sppaf2IySovrhVBtt8+yz+g4NRKyz8oAcGBSuBBAAKoUQDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==`
- Public key (SPKI, base64): `MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==`
- Certificate `cert.pem` (base64 DER): see `reference-samples/…/Data/Certificates/cert.pem`. It is the sandbox PCSID, valid 2024-01-11 to 2029-01-09.

**Per-certificate values:**

| Field | Value |
|---|---|
| CertDigest | `ZDMwMmI0MTE1NzVjOTU2NTk4YzVlODhhYmI0ODU2NDUyNTU2YTVhYjhhMDFmN2FjYjk1YTA2OWQ0NjY2MjQ4NQ==` |
| Issuer | `CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local` |
| Serial | `379112742831380471835263969587287663520528387` |
| QR tag 9 (hex) | `3045022100b13f89c8669d65c250a51b71adf2722f28ab068bbc574756342bbde23dbaa01b02203d842e0cf2380c0400cf4b399ddae88f240ea0291dcb134dd4ef97aa6c2feb5c` |

**Per-document values:**

| Sample | Invoice hash (b64 raw) | SignedProperties digest (b64 hex) | SigningTime |
|---|---|---|---|
| `Simplified/Invoice/Simplified_Invoice.xml` | `z5F9qsS6oWyDhehD8u8S0DaxV+2CUiUz9Y+UsR61JgQ=` | `ZmMwY2ZhNDljNzNjZDA5NmY4NDM4MmY1ZmY1YTA0NjY3MzY4NzMxOGJhYmZmNWU1OGYzZWJlODI3ZDgyZGVkZA==` | `2025-07-22T15:51:28` |
| `Standard/Invoice/Standard_Invoice.xml` | `V4U5qlZ3yXQ/Si1AC/R8SLc3F+iNy27wdVe8IWRqFAQ=` | (see file) | (see file) |
| `Simplified/Credit/Simplified_Credit_Note.xml` | `2kBYLvmDlvKUxK/0ma+P8jFkKoiPh5VKBWjXERwUfxk=` | (see file) | (see file) |

All 19 SDK samples: the hash recomputed with §3 equals the file's DigestValue (19 of 19).

**Signature check:** `SignatureValue` of `Simplified_Invoice.xml` (`MEYCIQCYovp/Gxd/x2qZcDZZf+4TdtfZjU/1/fzS3EQjmZGhlQIhANTc0rlAs3ffQgrKi8V49eXV32d200XIutgCti4iGAjB`) verifies with `openssl dgst -sha256 -verify pub.pem -signature sig.der hash32.bin`, where `hash32.bin` = base64decode(`z5F9…JgQ=`). ECDSA is randomized, so test *verification*, not equality of signatures.

**QR decode** of `Simplified_Invoice.xml` (632 base64 characters, 473 bytes):

| Tag | Length | Value |
|---|---|---|
| 1 | 111 | `شركة توريد التكنولوجيا بأقصى سرعة المحدودة \| Maximum Speed Tech Supply LTD` |
| 2 | 15 | `399999999900003` |
| 3 | 19 | `2022-08-17T17:41:08` |
| 4 | 6 | `231.15` |
| 5 | 5 | `30.15` |
| 6 | 44 | `z5F9qsS6oWyDhehD8u8S0DaxV+2CUiUz9Y+UsR61JgQ=` |
| 7 | 96 | `MEYCIQ…AjB` |
| 8 | 88 | SPKI DER |
| 9 | 71 | Certificate signature DER |

**Minimal verification script** (Python/lxml; how every [SDK-VERIFIED] hash claim was checked):
```python
from lxml import etree; import hashlib, base64
NS={'ext':'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
    'cac':'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'cbc':'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'}
doc=etree.parse(path, etree.XMLParser(remove_blank_text=False)); root=doc.getroot()
for xp in ['/*/ext:UBLExtensions','/*/cac:Signature',"/*/cac:AdditionalDocumentReference[cbc:ID='QR']"]:
    for el in root.xpath(xp, namespaces=NS):
        p, prev, tail = el.getparent(), el.getprevious(), el.tail
        p.remove(el)                                   # lxml drops the tail -> re-attach it
        if tail:
            if prev is not None: prev.tail = (prev.tail or '') + tail
            else: p.text = (p.text or '') + tail
print(base64.b64encode(hashlib.sha256(etree.tostring(doc, method='c14n')).digest()).decode())
```

---

## 12. Discrepancies: official documents vs SDK behaviour

| # | Topic | Official text says | SDK 3.4.8 samples / validator do | Use |
|---|---|---|---|---|
| D1 | QR tag 6 | S-SEC §4.1: 32-byte hash | 44-byte base64 hash string (S-DTG worked example agrees) | SDK |
| D2 | SignedProperties digest | S-DTG step 5: linearize and remove spaces; base64 of raw digest | Hash of the indented text plus namespace declarations; base64 of **hex** | SDK |
| D3 | 2nd Reference `Type` | S-SEC: `http://uri.etsi.org/01903#SignedProperties` | `http://www.w3.org/2000/09/xmldsig#SignatureProperties` | SDK |
| D4 | XAdES properties | S-SEC: SigningCertificateV2, SignaturePolicyIdentifier, DataObjectFormat | SigningTime and SigningCertificate (v1) only | SDK |
| D5 | xades namespace | S-DD KSA-15: `urn:oasis:…:XAdESv141-2` | `http://uri.etsi.org/01903/v1.3.2#` | SDK |
| D6 | QR tag 4 | S-DTG: TaxInclusiveAmount | PayableAmount when prepaid or rounding is present | SDK (§5.3) |
| D7 | QR tag 5 | S-SEC v1.2: BT-110 | First TaxTotal (SAR, BT-111) | SDK; UNVERIFIED for non-SAR |
| D8 | VAT number in CSR | S-SEC Table 1: organizationIdentifier 2.5.4.97 | SAN dirName `UID` | Sample CSR |
| D9 | Template string type | S-FPM: PRINTABLESTRING | UTF8String in the official sample CSR | UTF8String |
| D10 | QR max length | S-SEC: 700 characters | BR-CL-KSA-14: 1000 | Stay ≤700 to be safe |
| D11 | KSA-2 length | S-XML: 7 | SDK accepts 7/8/9 (continuous supply, B2G) | 7 unless needed |
| D12 | Signature scope | S-SEC: XAdES/XMLDSig (implies signing SignedInfo) | ECDSA over the invoice-hash bytes only | SDK |
| D13 | Key | S-SEC profile table: "Key length: P-256" | secp256k1 everywhere | secp256k1 |

---

## 13. Open items / UNVERIFIED

1. Whether production accepts KSA-2 `@name` of length 8 or 9 (continuous supply / B2G flags).
2. QR tag 5 for non-SAR invoices (BT-110 vs BT-111), and the exact rule the platform uses for tag 4.
3. QR values of 128 bytes or more: BER long-form length is inferred from the SDK's TLV library (§5.1). I did not test a long-name QR against the live validator.
4. Whether `PrintableString` for the certificate template, or `SigningTime` with a `Z` suffix, is accepted in production.
5. Whether the platform accepts a SignedProperties indentation different from the SDK's (if self-consistent).
6. Official texts for `VATEX-SA-DIPLOMAT`, `VATEX-SA-DUTYFREE`, `VATEX-SA-ROYALDECREE` (present in the 3.4.8 schematron code list only).
7. Reporting behaviour when `Clearance-Status` is omitted in production; API rate limits and timeouts.
8. Whether the published sandbox dummy credentials and OTP still work today (no live API calls were made).
9. Wave 24 threshold and date at the primary source.
