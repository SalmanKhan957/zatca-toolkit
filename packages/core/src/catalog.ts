/**
 * Plain-language explanations (English + Arabic) for the ZATCA rule codes and platform
 * error codes developers hit most often. Rule codes and severities follow ZATCA SDK 3.4.8.
 */
export type Severity = 'error' | 'warning';

export interface CatalogEntry {
  code: string;
  severity: Severity;
  /** What the rule requires */
  en: string;
  ar: string;
  /** How to fix it */
  fix: string;
}

const entries: CatalogEntry[] = [
  // ---- document header ----
  { code: 'BR-KSA-EN16931-01', severity: 'error', en: 'ProfileID must be "reporting:1.0".', ar: 'يجب أن تكون قيمة ProfileID هي "reporting:1.0".', fix: 'Set <cbc:ProfileID>reporting:1.0</cbc:ProfileID>.' },
  { code: 'BR-KSA-03', severity: 'error', en: 'The invoice UUID may only contain letters, digits and dashes.', ar: 'يجب أن يحتوي المعرف الفريد (UUID) على أحرف وأرقام وشرطات فقط.', fix: 'Generate a v4 UUID, e.g. crypto.randomUUID().' },
  { code: 'BR-KSA-04', severity: 'error', en: 'The issue date must not be in the future.', ar: 'يجب ألا يكون تاريخ الإصدار في المستقبل.', fix: 'Check your server clock and time zone: KSA is UTC+3.' },
  { code: 'BR-KSA-F-01', severity: 'error', en: 'Dates must be written as YYYY-MM-DD.', ar: 'يجب كتابة التواريخ بالصيغة YYYY-MM-DD.', fix: 'Use e.g. 2026-11-10, with no time or zone.' },
  { code: 'BR-KSA-70', severity: 'error', en: 'The issue time must be HH:mm:ss (local KSA time) or HH:mm:ssZ (UTC).', ar: 'يجب أن يكون وقت الإصدار بالصيغة HH:mm:ss أو HH:mm:ssZ.', fix: 'No milliseconds and no offsets such as +03:00.' },
  { code: 'BR-KSA-05', severity: 'error', en: 'The invoice type code must be 388 (invoice), 381 (credit note), 383 (debit note) or 386 (prepayment).', ar: 'يجب أن يكون رمز نوع الفاتورة 388 أو 381 أو 383 أو 386.', fix: 'Set <cbc:InvoiceTypeCode> to one of these codes.' },
  { code: 'BR-KSA-06', severity: 'error', en: 'InvoiceTypeCode/@name must be 01 (standard) or 02 (simplified) followed by five 0/1 flags.', ar: 'يجب أن تبدأ سمة name في رمز نوع الفاتورة بـ 01 (قياسية) أو 02 (مبسطة) تليها خمس خانات 0 أو 1.', fix: 'Use 0100000 for a standard invoice and 0200000 for a simplified invoice.' },
  { code: 'BR-KSA-31', severity: 'error', en: 'Simplified invoices cannot be self-billed.', ar: 'لا يجوز أن تكون الفاتورة المبسطة ذاتية الإصدار.', fix: 'Set the last flag of @name to 0, or issue a standard invoice.' },
  { code: 'BR-KSA-68', severity: 'error', en: 'TaxCurrencyCode is required.', ar: 'رمز عملة الضريبة (TaxCurrencyCode) مطلوب.', fix: 'Add <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>.' },
  { code: 'BR-KSA-EN16931-02', severity: 'error', en: 'TaxCurrencyCode must be SAR.', ar: 'يجب أن تكون عملة الضريبة الريال السعودي (SAR).', fix: 'Set <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>.' },
  { code: 'BR-KSA-33', severity: 'error', en: 'The invoice counter value (ICV) is missing.', ar: 'قيمة عداد الفاتورة (ICV) مفقودة.', fix: 'Add an AdditionalDocumentReference with ID "ICV" and the counter in cbc:UUID.' },
  { code: 'BR-KSA-34', severity: 'error', en: 'The invoice counter value (ICV) must contain digits only.', ar: 'يجب أن تحتوي قيمة عداد الفاتورة (ICV) على أرقام فقط.', fix: 'Use a strictly increasing integer per EGS unit.' },
  { code: 'BR-KSA-61', severity: 'warning', en: 'The previous invoice hash (PIH) is missing.', ar: 'تجزئة الفاتورة السابقة (PIH) مفقودة.', fix: 'Add an AdditionalDocumentReference with ID "PIH". For the first invoice use NWZlY2ViNjZm...OQ==.' },
  { code: 'BR-KSA-26', severity: 'warning', en: 'The previous invoice hash (PIH) must be a base64-encoded SHA-256 hash.', ar: 'يجب أن تكون تجزئة الفاتورة السابقة (PIH) تجزئة SHA-256 مرمزة بصيغة base64.', fix: "Use the previous document's invoice hash exactly as you computed it." },
  { code: 'BR-KSA-17', severity: 'error', en: 'Credit and debit notes must state the reason for issuing them (KSA-10).', ar: 'يجب أن تتضمن إشعارات الدائن والمدين سبب الإصدار.', fix: 'Add <cac:PaymentMeans><cbc:PaymentMeansCode>…</cbc:PaymentMeansCode><cbc:InstructionNote>reason</cbc:InstructionNote></cac:PaymentMeans>.' },
  { code: 'BR-KSA-56', severity: 'warning', en: 'Credit and debit notes must reference the original invoice (BT-25).', ar: 'يجب أن تشير إشعارات الدائن والمدين إلى الفاتورة الأصلية.', fix: 'Add <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>original number</cbc:ID>…' },
  { code: 'BR-16', severity: 'error', en: 'An invoice must have at least one line.', ar: 'يجب أن تحتوي الفاتورة على بند واحد على الأقل.', fix: 'Add a cac:InvoiceLine.' },
  { code: 'BR-KSA-F-04', severity: 'error', en: 'All amounts and quantities must be positive, including in credit notes.', ar: 'يجب أن تكون جميع المبالغ والكميات موجبة، بما في ذلك في الإشعارات الدائنة.', fix: 'The type code (381/383) gives the direction; keep the numbers positive.' },

  // ---- seller ----
  { code: 'BR-KSA-40', severity: 'error', en: 'The seller VAT number must be 15 digits, starting and ending with 3.', ar: 'يجب أن يتكون الرقم الضريبي للبائع من 15 رقماً يبدأ وينتهي بالرقم 3.', fix: 'Check the VAT registration certificate.' },
  { code: 'BR-KSA-08', severity: 'warning', en: 'The seller identification scheme must be one of CRN, MOM, MLS, 700, SAG or OTH.', ar: 'يجب أن يكون نوع معرف البائع أحد: CRN أو MOM أو MLS أو 700 أو SAG أو OTH.', fix: 'Usually schemeID="CRN" with the commercial registration number.' },
  { code: 'BR-KSA-09', severity: 'warning', en: 'The seller address must include street, building number, postal code, city, district and country.', ar: 'يجب أن يتضمن عنوان البائع الشارع ورقم المبنى والرمز البريدي والمدينة والحي والدولة.', fix: 'Use the Saudi National Address fields.' },
  { code: 'BR-KSA-37', severity: 'warning', en: 'The seller building number must be 4 digits.', ar: 'يجب أن يتكون رقم مبنى البائع من 4 أرقام.', fix: 'Use the building number from the National Address.' },
  { code: 'BR-KSA-66', severity: 'warning', en: 'The seller postal code must be 5 digits.', ar: 'يجب أن يتكون الرمز البريدي للبائع من 5 أرقام.', fix: 'Use the 5-digit postal code from the National Address.' },

  // ---- buyer ----
  { code: 'BR-KSA-42', severity: 'warning', en: 'Standard invoices must include the buyer name.', ar: 'يجب أن تتضمن الفاتورة القياسية اسم المشتري.', fix: 'Add cac:PartyLegalEntity/cbc:RegistrationName for the buyer.' },
  { code: 'BR-KSA-44', severity: 'error', en: 'The buyer VAT number must be 15 digits, starting and ending with 3.', ar: 'يجب أن يتكون الرقم الضريبي للمشتري من 15 رقماً يبدأ وينتهي بالرقم 3.', fix: 'Omit it if the buyer is not VAT-registered and use an ID instead.' },
  { code: 'BR-KSA-81', severity: 'warning', en: 'Standard invoices need a buyer identification when the buyer has no VAT number.', ar: 'تحتاج الفاتورة القياسية إلى معرف للمشتري إذا لم يكن لديه رقم ضريبي.', fix: 'Add cac:PartyIdentification/cbc:ID with schemeID (e.g. CRN, NAT, IQA).' },
  { code: 'BR-KSA-14', severity: 'error', en: 'The buyer identification scheme must be one of TIN, CRN, MOM, MLS, 700, SAG, NAT, GCC, IQA, PAS or OTH.', ar: 'يجب أن يكون نوع معرف المشتري أحد: TIN أو CRN أو MOM أو MLS أو 700 أو SAG أو NAT أو GCC أو IQA أو PAS أو OTH.', fix: 'Fix the schemeID attribute.' },
  { code: 'BR-KSA-63', severity: 'warning', en: 'For a Saudi buyer on a standard invoice, the address must include street, building number, postal code, city, district and country.', ar: 'للمشتري السعودي في الفاتورة القياسية، يجب أن يتضمن العنوان الشارع ورقم المبنى والرمز البريدي والمدينة والحي والدولة.', fix: 'Use the buyer\'s National Address.' },
  { code: 'BR-KSA-67', severity: 'warning', en: 'A Saudi buyer postal code must be 5 digits.', ar: 'يجب أن يتكون الرمز البريدي للمشتري السعودي من 5 أرقام.', fix: 'Use the 5-digit postal code.' },
  { code: 'BR-CUSTOM-VALIDATION-01', severity: 'error', en: 'The seller and buyer VAT numbers must differ.', ar: 'يجب أن يختلف الرقم الضريبي للبائع عن الرقم الضريبي للمشتري.', fix: 'Check you did not copy the seller VAT into the buyer.' },
  { code: 'BR-KSA-15', severity: 'warning', en: 'Standard tax invoices must include the supply date (KSA-5).', ar: 'يجب أن تتضمن الفاتورة الضريبية القياسية تاريخ التوريد.', fix: 'Add <cac:Delivery><cbc:ActualDeliveryDate>YYYY-MM-DD</cbc:ActualDeliveryDate></cac:Delivery>.' },

  // ---- VAT ----
  { code: 'BR-KSA-18', severity: 'error', en: 'The VAT category must be S, Z, E or O.', ar: 'يجب أن تكون فئة ضريبة القيمة المضافة S أو Z أو E أو O.', fix: 'S = 15%, Z = zero-rated, E = exempt, O = out of scope.' },
  { code: 'BR-KSA-84', severity: 'error', en: 'Standard-rated (S) items must use a rate of 15% (or 5% where applicable).', ar: 'يجب أن تكون نسبة الضريبة للبنود الخاضعة للنسبة الأساسية 15% (أو 5% حيث ينطبق).', fix: 'Set cbc:Percent to 15.00.' },
  { code: 'BR-KSA-CL-04', severity: 'warning', en: 'Zero-rated, exempt and out-of-scope VAT need a valid VATEX exemption code for their category.', ar: 'تحتاج البنود المعفاة أو الخاضعة للنسبة الصفرية أو خارج النطاق إلى رمز إعفاء VATEX صالح لفئتها.', fix: 'Z: VATEX-SA-32..36/EDU/HEA/MLTRY; E: VATEX-SA-29/29-7/30; O: VATEX-SA-OOS.' },
  { code: 'BR-KSA-83', severity: 'warning', en: 'An exemption reason text is required when an exemption code is used.', ar: 'يجب ذكر نص سبب الإعفاء عند استخدام رمز إعفاء.', fix: 'Add cbc:TaxExemptionReason, e.g. "Export of goods".' },
  { code: 'BR-S-10', severity: 'warning', en: 'Standard-rated (S) VAT must not carry an exemption reason.', ar: 'يجب ألا تحتوي الضريبة بالنسبة الأساسية على سبب إعفاء.', fix: 'Remove TaxExemptionReasonCode/TaxExemptionReason from S categories.' },
  { code: 'BR-KSA-EN16931-08', severity: 'warning', en: 'Exactly one TaxTotal with VAT breakdown (TaxSubtotal) must be present.', ar: 'يجب وجود عنصر TaxTotal واحد فقط يتضمن تفاصيل الضريبة.', fix: 'Keep one TaxTotal with TaxSubtotal elements.' },
  { code: 'BR-KSA-EN16931-09', severity: 'warning', en: 'Exactly one TaxTotal without breakdown (the SAR total) must be present.', ar: 'يجب وجود عنصر TaxTotal واحد فقط بدون تفاصيل (إجمالي الضريبة بالريال).', fix: 'Add <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">…</cbc:TaxAmount></cac:TaxTotal> before the detailed one.' },
  { code: 'BR-KSA-52', severity: 'error', en: 'Each line must carry its VAT amount (KSA-11).', ar: 'يجب أن يتضمن كل بند مبلغ الضريبة الخاص به.', fix: 'Add cac:TaxTotal/cbc:TaxAmount to every InvoiceLine.' },
  { code: 'BR-KSA-53', severity: 'error', en: 'Each line must carry its amount including VAT (KSA-12, in cbc:RoundingAmount).', ar: 'يجب أن يتضمن كل بند مبلغه شاملاً الضريبة.', fix: 'Add cac:TaxTotal/cbc:RoundingAmount = line net + line VAT.' },
  { code: 'BR-KSA-51', severity: 'warning', en: 'Line amount including VAT must equal line net amount plus line VAT.', ar: 'يجب أن يساوي مبلغ البند شاملاً الضريبة صافي البند مضافاً إليه ضريبته.', fix: 'Recompute RoundingAmount = LineExtensionAmount + TaxAmount.' },
  { code: 'BR-CO-10', severity: 'warning', en: 'LineExtensionAmount must equal the sum of the line net amounts.', ar: 'يجب أن يساوي إجمالي صافي البنود مجموع صافي مبالغ البنود.', fix: 'Recompute the total from the lines.' },
  { code: 'BR-CO-13', severity: 'warning', en: 'TaxExclusiveAmount must equal line total minus allowances plus charges.', ar: 'يجب أن يساوي الإجمالي غير شامل الضريبة مجموع البنود ناقص الخصومات زائد الرسوم.', fix: 'Recompute TaxExclusiveAmount.' },
  { code: 'BR-CO-14', severity: 'error', en: 'The invoice VAT total must equal the sum of the VAT category amounts.', ar: 'يجب أن يساوي إجمالي الضريبة مجموع مبالغ الضريبة لكل فئة.', fix: 'Recompute TaxTotal/TaxAmount from the TaxSubtotals.' },
  { code: 'BR-CO-15', severity: 'error', en: 'TaxInclusiveAmount must equal TaxExclusiveAmount plus the VAT total.', ar: 'يجب أن يساوي الإجمالي شامل الضريبة الإجمالي غير شامل الضريبة زائد إجمالي الضريبة.', fix: 'Recompute TaxInclusiveAmount.' },
  { code: 'BR-CO-16', severity: 'warning', en: 'PayableAmount must equal TaxInclusiveAmount minus PrepaidAmount plus rounding.', ar: 'يجب أن يساوي المبلغ المستحق الإجمالي شامل الضريبة ناقص المدفوع مقدماً زائد التقريب.', fix: 'Recompute PayableAmount.' },
  { code: 'BR-CO-17', severity: 'warning', en: 'Each VAT category amount must equal its taxable amount times the rate, rounded half-up to 2 decimals.', ar: 'يجب أن يساوي مبلغ الضريبة لكل فئة المبلغ الخاضع للضريبة مضروباً في النسبة مقرباً إلى خانتين عشريتين.', fix: 'Compute VAT on the category total, not as a sum of rounded line VATs.' },

  // ---- cryptographic stamp & QR ----
  { code: 'BR-KSA-60', severity: 'warning', en: 'Simplified invoices must carry the cryptographic stamp (signature).', ar: 'يجب أن تحمل الفاتورة المبسطة الختم التشفيري.', fix: 'Sign the invoice with your CSID before sharing or reporting it.' },
  { code: 'BR-KSA-27', severity: 'warning', en: 'Simplified invoices must carry a base64 QR code.', ar: 'يجب أن تحمل الفاتورة المبسطة رمز QR مرمزاً بصيغة base64.', fix: 'Signing adds the QR code automatically.' },
  { code: 'BR-CL-KSA-14', severity: 'error', en: 'The QR code payload must be at most 1000 base64 characters.', ar: 'يجب ألا يتجاوز رمز QR ألف حرف بصيغة base64.', fix: 'Shorten very long seller names.' },
  { code: 'invalid-invoice-hash', severity: 'error', en: 'The invoice hash does not match the document.', ar: 'تجزئة الفاتورة لا تطابق المستند.', fix: 'Do not reformat the XML after signing; submit exactly the signed text, and remove only UBLExtensions, cac:Signature and the QR reference (keeping whitespace) before hashing.' },
  { code: 'invalid-digital-signature', severity: 'error', en: 'The ECDSA signature does not verify.', ar: 'التوقيع الرقمي غير صالح.', fix: 'Sign the 32 raw hash bytes with SHA256withECDSA, using the key that matches the certificate.' },
  { code: 'xades-Signed-Properties-Digest-Value', severity: 'error', en: 'The SignedProperties digest is wrong.', ar: 'قيمة تجزئة الخصائص الموقعة غير صحيحة.', fix: 'Hash the SignedProperties text exactly as emitted, with xmlns:xades/xmlns:ds injected, and write base64 of the hex digest.' },
  { code: 'Signing-Certificate-Digest-Value', severity: 'error', en: 'The certificate digest is wrong.', ar: 'قيمة تجزئة الشهادة غير صحيحة.', fix: 'CertDigest = base64(hex(sha256(base64 certificate text))), not a hash of the DER bytes.' },
  { code: 'X-509-Issuer-Name', severity: 'error', en: 'The certificate issuer name does not match.', ar: 'اسم مصدر الشهادة غير مطابق.', fix: 'Write the issuer RDNs most-specific first, joined by ", " (comma + space).' },
  { code: 'X509-Serial-Number', severity: 'error', en: 'The certificate serial number does not match.', ar: 'الرقم التسلسلي للشهادة غير مطابق.', fix: 'Write the serial as a decimal integer (BigInt), not hex.' },
  { code: 'QRCODE_INVALID', severity: 'error', en: 'The QR code is missing or not valid TLV.', ar: 'رمز QR مفقود أو بصيغة غير صالحة.', fix: 'Use BER lengths: values of 128+ bytes need the long form 0x81 LL.' },
  { code: 'invoiceHash_QRCODE_INVALID', severity: 'error', en: 'QR tag 6 does not match the invoice hash.', ar: 'الحقل 6 في رمز QR لا يطابق تجزئة الفاتورة.', fix: 'Tag 6 is the base64 hash string (44 ASCII bytes).' },
  { code: 'invoiceTimeStamp_QRCODE_INVALID', severity: 'warning', en: 'QR tag 3 does not match IssueDate + "T" + IssueTime.', ar: 'الحقل 3 في رمز QR لا يطابق تاريخ ووقت الإصدار.', fix: 'Copy the XML text exactly; do not add Z or milliseconds.' },
  { code: 'invoiceTotal_QRCODE_INVALID', severity: 'warning', en: 'QR tag 4 does not match the invoice total.', ar: 'الحقل 4 في رمز QR لا يطابق إجمالي الفاتورة.', fix: 'Use TaxInclusiveAmount, or PayableAmount when there is a prepayment or rounding adjustment.' },
  { code: 'XSD_ZATCA_INVALID', severity: 'error', en: 'The XML does not match the UBL 2.1 schema (wrong element order or a missing element).', ar: 'المستند لا يطابق مخطط UBL 2.1 (ترتيب العناصر خاطئ أو عنصر مفقود).', fix: 'Check the element order against ZATCA\'s samples; the message gives the line and column.' },
  { code: 'Invalid-OTP', severity: 'error', en: 'The OTP is invalid or expired.', ar: 'رمز التحقق (OTP) غير صالح أو منتهي الصلاحية.', fix: 'OTPs last 1 hour and are consumed by their first use; generate a new one in the Fatoora portal. Sandbox OTP: 123345.' },
  { code: 'Invalid-CSR', severity: 'error', en: 'ZATCA rejected the CSR.', ar: 'رفضت هيئة الزكاة طلب توقيع الشهادة.', fix: 'Check the template name for the environment (TSTZATCA/PREZATCA/ZATCA-Code-Signing), the SAN fields, and send base64 of the PEM text.' },
  { code: 'Missing-ComplianceSteps', severity: 'error', en: 'Compliance checks are not complete for this compliance CSID.', ar: 'لم تكتمل فحوصات الامتثال لهذه الشهادة.', fix: 'Submit a passing invoice, credit note and debit note for each type your CSR declares (title 1100 = all six).' },
];

export const RULES: Record<string, CatalogEntry> = Object.fromEntries(entries.map((e) => [e.code, e]));

/** Look up a ZATCA rule or error code (case-insensitive, tolerant of "[BR-KSA-98] - …" message prefixes). */
export function explainCode(codeOrMessage: string): CatalogEntry | undefined {
  const m = /\[?([A-Za-z0-9_-]+(?:-[A-Za-z0-9]+)*)\]?/.exec(codeOrMessage.trim());
  const key = (m?.[1] ?? codeOrMessage).trim();
  return RULES[key] ?? Object.values(RULES).find((e) => e.code.toLowerCase() === key.toLowerCase());
}
