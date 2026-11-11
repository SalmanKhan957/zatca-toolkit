import { type CatalogEntry, RULES, type Severity } from './catalog.js';
import { NS, XmlParseError, child, children, descendants, parseXml, path, text } from './dom.js';
import { base64ToBytes, bytesToBase64 } from './encoding.js';
import { INITIAL_PREVIOUS_INVOICE_HASH, computeInvoiceHash } from './hash.js';
import { verifyEcdsa } from './keys.js';
import { Decimal, sum } from './money.js';
import { decodeQr } from './qr.js';
import { extractSignedPropertiesText, signedPropertiesDigest } from './signed-properties.js';
import { formatName, parseCertificate, zatcaCertDigest } from './x509.js';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  messageAr: string;
  fix?: string;
  /** Extra detail about this occurrence, e.g. the offending value */
  detail?: string;
}

export interface ValidationReport {
  /** No error-level findings (warnings are allowed by ZATCA) */
  valid: boolean;
  kind?: 'standard' | 'simplified';
  documentType?: 'invoice' | 'credit-note' | 'debit-note' | 'prepayment';
  signed: boolean;
  invoiceHash?: string;
  errors: Finding[];
  warnings: Finding[];
  /** Cryptographic checks performed on signed documents */
  signatureChecks: Array<{ check: string; passed: boolean; detail?: string }>;
}

export interface ValidateOptions {
  /** Reference time for "not in the future" checks; defaults to now */
  now?: Date;
}

const SELLER_SCHEMES = new Set(['CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH']);
const BUYER_SCHEMES = new Set(['TIN', 'CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'OTH']);
const EXEMPTION_CODES: Record<string, RegExp> = {
  Z: /^VATEX-SA-(32|33|34-[1-5]|35|36|EDU|HEA|MLTRY|DIPLOMAT|DUTYFREE|ROYALDECREE)$/,
  E: /^VATEX-SA-(29|29-7|30)$/,
  O: /^VATEX-SA-OOS$/,
};
const VAT_RE = /^3\d{13}3$/;

/**
 * Validate a ZATCA e-invoice offline: structure, the most common BR-KSA and EN 16931
 * business rules, totals arithmetic, and (for signed documents) the hash, ECDSA
 * signature, XAdES digests and QR code. Messages come in English and Arabic.
 *
 * This is a fast pre-flight check, not a replacement for ZATCA's validator: it covers
 * the rules developers most often break, not all 240+ schematron assertions.
 */
export function validateInvoice(xml: string, options: ValidateOptions = {}): ValidationReport {
  const findings: Finding[] = [];
  const signatureChecks: ValidationReport['signatureChecks'] = [];
  let kind: 'standard' | 'simplified' | undefined;
  let documentType: ValidationReport['documentType'];
  let signed = false;
  let invoiceHash: string | undefined;
  const add = (code: string, detail?: string, override?: Partial<CatalogEntry>) => {
    const r = RULES[code];
    const severity = override?.severity ?? r?.severity ?? 'error';
    findings.push({
      code,
      severity,
      message: override?.en ?? r?.en ?? code,
      messageAr: override?.ar ?? r?.ar ?? code,
      ...((override?.fix ?? r?.fix) !== undefined && { fix: override?.fix ?? r?.fix }),
      ...(detail !== undefined && { detail }),
    });
  };

  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch (e) {
    add('XSD_ZATCA_INVALID', e instanceof XmlParseError ? e.message : String(e), { en: 'The document is not well-formed XML.', ar: 'المستند ليس بصيغة XML سليمة.' });
    return finish();
  }
  const root = doc.documentElement as Element;
  if (root.localName !== 'Invoice' || root.namespaceURI !== NS.invoice) {
    add('XSD_ZATCA_INVALID', `Root element is <${root.tagName}>`, { en: 'The root element must be <Invoice> in the UBL Invoice-2 namespace (credit and debit notes use <Invoice> too).', ar: 'يجب أن يكون العنصر الجذري <Invoice> (حتى لإشعارات الدائن والمدين).' });
    return finish();
  }

  const t = (el: Element | undefined) => text(el)?.trim();
  const cbc = (name: string) => t(child(root, NS.cbc, name));

  // ---------- header ----------
  if (cbc('ProfileID') !== 'reporting:1.0') add('BR-KSA-EN16931-01', `Found "${cbc('ProfileID') ?? ''}"`);
  const uuid = cbc('UUID');
  if (!uuid || !/^[A-Za-z0-9-]+$/.test(uuid)) add('BR-KSA-03', uuid ? `Found "${uuid}"` : 'UUID is missing');

  const issueDate = cbc('IssueDate');
  const issueTime = cbc('IssueTime');
  if (!issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) add('BR-KSA-F-01', `IssueDate "${issueDate ?? ''}"`);
  if (!issueTime || !/^\d{2}:\d{2}:\d{2}Z?$/.test(issueTime)) add('BR-KSA-70', `IssueTime "${issueTime ?? ''}"`);
  if (issueDate && /^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    const nowKsa = new Date((options.now ?? new Date()).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    if (issueDate > nowKsa) add('BR-KSA-04', `IssueDate ${issueDate} is after today in KSA (${nowKsa})`);
  }

  const typeEl = child(root, NS.cbc, 'InvoiceTypeCode');
  const typeCode = t(typeEl);
  const typeName = typeEl?.getAttribute('name') ?? '';
  if (!typeCode || !['388', '381', '383', '386'].includes(typeCode)) add('BR-KSA-05', `Found "${typeCode ?? ''}"`);
  if (!/^0[12][01]{5}([01]{1,2})?$/.test(typeName)) add('BR-KSA-06', `Found name="${typeName}"`);
  kind = typeName.startsWith('01') ? 'standard' : typeName.startsWith('02') ? 'simplified' : undefined;
  documentType =
    typeCode === '381' ? 'credit-note' : typeCode === '383' ? 'debit-note' : typeCode === '386' ? 'prepayment' : typeCode === '388' ? 'invoice' : undefined;
  if (kind === 'simplified' && typeName[6] === '1') add('BR-KSA-31');

  const taxCurrency = cbc('TaxCurrencyCode');
  if (!taxCurrency) add('BR-KSA-68');
  else if (taxCurrency !== 'SAR') add('BR-KSA-EN16931-02', `Found "${taxCurrency}"`);

  const adrs = children(root, NS.cac, 'AdditionalDocumentReference');
  const adr = (id: string) => adrs.find((a) => t(child(a, NS.cbc, 'ID')) === id);
  const icv = adr('ICV');
  if (!icv) add('BR-KSA-33');
  else if (!/^\d+$/.test(t(child(icv, NS.cbc, 'UUID')) ?? '')) add('BR-KSA-34', `Found "${t(child(icv, NS.cbc, 'UUID')) ?? ''}"`);
  const pihEl = adr('PIH');
  const pih = t(path(pihEl, [NS.cac, 'Attachment'], [NS.cbc, 'EmbeddedDocumentBinaryObject']));
  if (!pihEl || !pih) add('BR-KSA-61');
  else if (pih !== INITIAL_PREVIOUS_INVOICE_HASH && !isSha256Base64(pih)) add('BR-KSA-26', `Found "${pih.slice(0, 20)}…"`);

  if (documentType === 'credit-note' || documentType === 'debit-note') {
    const reason = t(path(root, [NS.cac, 'PaymentMeans'], [NS.cbc, 'InstructionNote']));
    if (!reason) add('BR-KSA-17');
    if (!t(path(root, [NS.cac, 'BillingReference'], [NS.cac, 'InvoiceDocumentReference'], [NS.cbc, 'ID']))) add('BR-KSA-56');
  }

  // ---------- parties ----------
  const seller = path(root, [NS.cac, 'AccountingSupplierParty'], [NS.cac, 'Party']);
  const sellerVat = t(path(seller, [NS.cac, 'PartyTaxScheme'], [NS.cbc, 'CompanyID']));
  if (!sellerVat || !VAT_RE.test(sellerVat)) add('BR-KSA-40', `Found "${sellerVat ?? ''}"`);
  const sellerIdEl = path(seller, [NS.cac, 'PartyIdentification'], [NS.cbc, 'ID']);
  if (sellerIdEl && !SELLER_SCHEMES.has(sellerIdEl.getAttribute('schemeID') ?? '')) add('BR-KSA-08', `schemeID="${sellerIdEl.getAttribute('schemeID') ?? ''}"`);
  checkAddress(child(seller ?? root, NS.cac, 'PostalAddress'), 'BR-KSA-09', 'BR-KSA-37', 'BR-KSA-66', true);

  const buyer = path(root, [NS.cac, 'AccountingCustomerParty'], [NS.cac, 'Party']);
  const buyerVat = t(path(buyer, [NS.cac, 'PartyTaxScheme'], [NS.cbc, 'CompanyID']));
  if (buyerVat && !VAT_RE.test(buyerVat)) add('BR-KSA-44', `Found "${buyerVat}"`);
  if (buyerVat && sellerVat && buyerVat === sellerVat) add('BR-CUSTOM-VALIDATION-01');
  const buyerIdEl = path(buyer, [NS.cac, 'PartyIdentification'], [NS.cbc, 'ID']);
  if (buyerIdEl && !BUYER_SCHEMES.has(buyerIdEl.getAttribute('schemeID') ?? '')) add('BR-KSA-14', `schemeID="${buyerIdEl.getAttribute('schemeID') ?? ''}"`);
  if (kind === 'standard') {
    if (!t(path(buyer, [NS.cac, 'PartyLegalEntity'], [NS.cbc, 'RegistrationName']))) add('BR-KSA-42');
    if (!buyerVat && !buyerIdEl) add('BR-KSA-81');
    const buyerAddress = child(buyer ?? root, NS.cac, 'PostalAddress');
    if (t(path(buyerAddress, [NS.cac, 'Country'], [NS.cbc, 'IdentificationCode'])) === 'SA') {
      checkAddress(buyerAddress, 'BR-KSA-63', undefined, 'BR-KSA-67', false);
    }
    if (typeCode === '388' && !t(path(root, [NS.cac, 'Delivery'], [NS.cbc, 'ActualDeliveryDate']))) add('BR-KSA-15');
  }

  // ---------- VAT and totals ----------
  const lines = children(root, NS.cac, 'InvoiceLine');
  if (lines.length === 0) add('BR-16');

  const amount = (el: Element | undefined): Decimal | undefined => {
    const v = t(el);
    if (v === undefined || v === '') return undefined;
    try {
      return Decimal.from(v);
    } catch {
      return undefined;
    }
  };

  for (const a of descendants(root, NS.cbc, 'Amount').concat(descendants(root, NS.cbc, 'InvoicedQuantity'), descendants(root, NS.cbc, 'PriceAmount'))) {
    const v = amount(a);
    if (v?.isNegative()) {
      add('BR-KSA-F-04', `${a.tagName} = ${t(a)}`);
      break;
    }
  }

  const taxTotals = children(root, NS.cac, 'TaxTotal');
  const withSub = taxTotals.filter((tt) => children(tt, NS.cac, 'TaxSubtotal').length > 0);
  const withoutSub = taxTotals.filter((tt) => children(tt, NS.cac, 'TaxSubtotal').length === 0);
  if (withSub.length !== 1) add('BR-KSA-EN16931-08', `Found ${withSub.length}`);
  if (withoutSub.length !== 1) add('BR-KSA-EN16931-09', `Found ${withoutSub.length}`);

  const checkCategory = (cat: Element | undefined, where: string) => {
    if (!cat) return;
    const id = t(child(cat, NS.cbc, 'ID')) ?? '';
    const pct = t(child(cat, NS.cbc, 'Percent'));
    const code = t(child(cat, NS.cbc, 'TaxExemptionReasonCode'));
    const reason = t(child(cat, NS.cbc, 'TaxExemptionReason'));
    if (!['S', 'Z', 'E', 'O'].includes(id)) {
      add('BR-KSA-18', `${where}: "${id}"`);
      return;
    }
    if (id === 'S' && pct !== undefined && !['15', '5'].includes(Decimal.from(pct).toString())) add('BR-KSA-84', `${where}: ${pct}%`);
    if (where.startsWith('VAT breakdown')) {
      if (id !== 'S' && (!code || !EXEMPTION_CODES[id]!.test(code))) add('BR-KSA-CL-04', `${where}: category ${id}, code "${code ?? ''}"`);
      if (id !== 'S' && code && !reason) add('BR-KSA-83', where);
      if (id === 'S' && (code || reason)) add('BR-S-10', where);
    }
  };

  const subtotals = withSub[0] ? children(withSub[0], NS.cac, 'TaxSubtotal') : [];
  subtotals.forEach((s, i) => {
    const cat = child(s, NS.cac, 'TaxCategory');
    checkCategory(cat, `VAT breakdown #${i + 1}`);
    const taxable = amount(child(s, NS.cbc, 'TaxableAmount'));
    const tax = amount(child(s, NS.cbc, 'TaxAmount'));
    const pct = amount(child(cat ?? s, NS.cbc, 'Percent')) ?? Decimal.zero();
    if (taxable && tax && !taxable.percent(pct).round(2).equals(tax)) {
      add('BR-CO-17', `Breakdown #${i + 1}: ${taxable.toFixed()} × ${pct.toString()}% = ${taxable.percent(pct).toFixed()}, found ${tax.toFixed()}`);
    }
  });

  let lineNetSum = Decimal.zero();
  lines.forEach((line, i) => {
    const lineId = t(child(line, NS.cbc, 'ID')) ?? String(i + 1);
    checkCategory(path(line, [NS.cac, 'Item'], [NS.cac, 'ClassifiedTaxCategory']), `Line ${lineId}`);
    const net = amount(child(line, NS.cbc, 'LineExtensionAmount'));
    if (net) lineNetSum = lineNetSum.plus(net);
    const lineTax = amount(path(line, [NS.cac, 'TaxTotal'], [NS.cbc, 'TaxAmount']));
    const lineGross = amount(path(line, [NS.cac, 'TaxTotal'], [NS.cbc, 'RoundingAmount']));
    if (kind === 'standard') {
      if (!lineTax) add('BR-KSA-52', `Line ${lineId}`);
      if (!lineGross) add('BR-KSA-53', `Line ${lineId}`);
    }
    if (net && lineTax && lineGross && !net.plus(lineTax).equals(lineGross)) {
      add('BR-KSA-51', `Line ${lineId}: ${net.toFixed()} + ${lineTax.toFixed()} ≠ ${lineGross.toFixed()}`);
    }
  });

  const lmt = child(root, NS.cac, 'LegalMonetaryTotal');
  const m = (name: string) => amount(child(lmt ?? root, NS.cbc, name));
  const lineExt = m('LineExtensionAmount');
  const taxExcl = m('TaxExclusiveAmount');
  const taxIncl = m('TaxInclusiveAmount');
  const allowanceTotal = m('AllowanceTotalAmount') ?? Decimal.zero();
  const chargeTotal = m('ChargeTotalAmount') ?? Decimal.zero();
  const prepaid = m('PrepaidAmount') ?? Decimal.zero();
  const rounding = m('PayableRoundingAmount') ?? Decimal.zero();
  const payable = m('PayableAmount');
  const docTax = amount(child(withSub[0] ?? root, NS.cbc, 'TaxAmount'));

  if (lineExt && lines.length > 0 && !lineNetSum.equals(lineExt)) add('BR-CO-10', `Σ lines = ${lineNetSum.toFixed()}, LineExtensionAmount = ${lineExt.toFixed()}`);
  if (lineExt && taxExcl && !lineExt.minus(allowanceTotal).plus(chargeTotal).equals(taxExcl)) {
    add('BR-CO-13', `${lineExt.toFixed()} − ${allowanceTotal.toFixed()} + ${chargeTotal.toFixed()} ≠ ${taxExcl.toFixed()}`);
  }
  if (docTax && subtotals.length > 0) {
    const s = sum(subtotals.map((x) => amount(child(x, NS.cbc, 'TaxAmount')) ?? Decimal.zero()));
    if (!s.equals(docTax)) add('BR-CO-14', `Σ breakdown = ${s.toFixed()}, TaxAmount = ${docTax.toFixed()}`);
  }
  if (taxExcl && taxIncl && docTax && !taxExcl.plus(docTax).equals(taxIncl)) add('BR-CO-15', `${taxExcl.toFixed()} + ${docTax.toFixed()} ≠ ${taxIncl.toFixed()}`);
  if (taxIncl && payable && !taxIncl.minus(prepaid).plus(rounding).equals(payable)) {
    add('BR-CO-16', `${taxIncl.toFixed()} − ${prepaid.toFixed()} + ${rounding.toFixed()} ≠ ${payable.toFixed()}`);
  }

  // ---------- signature and QR ----------
  const ublExt = child(root, NS.ext, 'UBLExtensions');
  signed = !!ublExt;
  const qrEl = adr('QR');
  const qrText = t(path(qrEl, [NS.cac, 'Attachment'], [NS.cbc, 'EmbeddedDocumentBinaryObject']));
  try {
    invoiceHash = computeInvoiceHash(doc);
  } catch {
    /* already reported as parse error */
  }

  if (kind === 'simplified' && !signed) add('BR-KSA-60');
  if (kind === 'simplified' && !qrText) add('BR-KSA-27');

  if (signed) {
    const sigEl = descendants(ublExt!, NS.ds, 'Signature')[0];
    const refs = sigEl ? descendants(sigEl, NS.ds, 'Reference') : [];
    const invoiceRef = refs.find((r) => r.getAttribute('Id') === 'invoiceSignedData');
    const propsRef = refs.find((r) => r.getAttribute('URI') === '#xadesSignedProperties');
    const check = (name: string, passed: boolean, code: string, detail?: string) => {
      signatureChecks.push({ check: name, passed, ...(detail !== undefined && { detail }) });
      if (!passed) add(code, detail);
    };

    const digest = t(child(invoiceRef ?? root, NS.ds, 'DigestValue'));
    check('Invoice hash matches ds:DigestValue', !!digest && digest === invoiceHash, 'invalid-invoice-hash', digest ? `computed ${invoiceHash}, document says ${digest}` : 'DigestValue missing');

    const certText = t(sigEl ? descendants(sigEl, NS.ds, 'X509Certificate')[0] : undefined);
    let cert: ReturnType<typeof parseCertificate> | undefined;
    try {
      cert = certText ? parseCertificate(certText) : undefined;
    } catch {
      cert = undefined;
    }
    if (!cert) {
      check('Certificate is readable', false, 'Signing-Certificate-Digest-Value', 'ds:X509Certificate is missing or not a certificate');
    } else {
      const sigValue = t(sigEl ? descendants(sigEl, NS.ds, 'SignatureValue')[0] : undefined);
      let sigOk = false;
      try {
        sigOk = !!sigValue && !!invoiceHash && verifyEcdsa(base64ToBytes(sigValue), base64ToBytes(invoiceHash), cert.publicKeyPoint);
      } catch {
        sigOk = false;
      }
      check('ECDSA signature verifies with the certificate key', sigOk, 'invalid-digital-signature');

      const certDigestEl = sigEl ? descendants(sigEl, NS.xades, 'CertDigest')[0] : undefined;
      const certDigest = t(certDigestEl ? descendants(certDigestEl, NS.ds, 'DigestValue')[0] : undefined);
      check('Certificate digest', certDigest === zatcaCertDigest(cert), 'Signing-Certificate-Digest-Value');
      const issuer = t(sigEl ? descendants(sigEl, NS.ds, 'X509IssuerName')[0] : undefined);
      check('Certificate issuer name', issuer === formatName(cert.issuer), 'X-509-Issuer-Name', `expected "${formatName(cert.issuer)}", found "${issuer ?? ''}"`);
      const serial = t(sigEl ? descendants(sigEl, NS.ds, 'X509SerialNumber')[0] : undefined);
      check('Certificate serial number', serial === cert.serialNumber.toString(10), 'X509-Serial-Number');

      const spText = extractSignedPropertiesText(xml);
      const spDigest = t(child(propsRef ?? root, NS.ds, 'DigestValue'));
      check('SignedProperties digest', !!spText && spDigest === signedPropertiesDigest(spText), 'xades-Signed-Properties-Digest-Value');

      if (qrText) {
        try {
          const qr = decodeQr(qrText);
          for (const w of qr.warnings) add('QRCODE_INVALID', w);
          const tag4 = prepaid.isZero() && rounding.isZero() ? t(child(lmt ?? root, NS.cbc, 'TaxInclusiveAmount')) : t(child(lmt ?? root, NS.cbc, 'PayableAmount'));
          check('QR tag 1 = seller name', qr.fields.sellerName === t(path(seller, [NS.cac, 'PartyLegalEntity'], [NS.cbc, 'RegistrationName'])), 'QRCODE_INVALID', 'Seller name differs');
          check('QR tag 2 = seller VAT number', qr.fields.vatNumber === sellerVat, 'QRCODE_INVALID', 'VAT number differs');
          check('QR tag 3 = issue timestamp', qr.fields.timestamp === `${issueDate}T${issueTime}`, 'invoiceTimeStamp_QRCODE_INVALID', `QR "${qr.fields.timestamp}" vs XML "${issueDate}T${issueTime}"`);
          check('QR tag 4 = invoice total', qr.fields.totalWithVat === tag4, 'invoiceTotal_QRCODE_INVALID', `QR "${qr.fields.totalWithVat}" vs XML "${tag4}"`);
          check('QR tag 5 = VAT total', qr.fields.vatTotal === t(child(withoutSub[0] ?? taxTotals[0] ?? root, NS.cbc, 'TaxAmount')), 'QRCODE_INVALID', 'VAT total differs');
          check('QR tag 6 = invoice hash', qr.fields.invoiceHash === invoiceHash, 'invoiceHash_QRCODE_INVALID');
          check('QR tag 7 = signature', qr.fields.signature === sigValue, 'QRCODE_INVALID', 'Signature differs');
          check('QR tag 8 = certificate public key', !!qr.fields.publicKey && bytesToBase64(qr.fields.publicKey) === bytesToBase64(cert.publicKeySpki), 'QRCODE_INVALID', 'Public key differs');
          if (kind === 'simplified') {
            check(
              'QR tag 9 = certificate signature',
              !!qr.fields.certificateSignature && bytesToBase64(qr.fields.certificateSignature) === bytesToBase64(cert.signatureValue),
              'QRCODE_INVALID',
              'Certificate signature differs or is missing',
            );
          }
          if (qrText.length > 1000) add('BR-CL-KSA-14', `${qrText.length} characters`);
        } catch (e) {
          check('QR code decodes', false, 'QRCODE_INVALID', (e as Error).message);
        }
      }
    }
  }

  return finish();

  function checkAddress(addr: Element | undefined, completenessCode: string, buildingCode: string | undefined, postalCode: string, isSeller: boolean) {
    const f = (name: string) => t(child(addr ?? root, NS.cbc, name));
    const missing = ['StreetName', 'BuildingNumber', 'PostalZone', 'CityName', 'CitySubdivisionName'].filter((n) => !addr || !f(n));
    if (!addr || !t(path(addr, [NS.cac, 'Country'], [NS.cbc, 'IdentificationCode']))) missing.push('Country');
    if (missing.length) add(completenessCode, `Missing: ${missing.join(', ')}`);
    const building = f('BuildingNumber');
    if (buildingCode && addr && building && !/^\d{4}$/.test(building)) add(buildingCode, `Found "${building}"`);
    const postal = f('PostalZone');
    const country = t(path(addr, [NS.cac, 'Country'], [NS.cbc, 'IdentificationCode']));
    if (addr && postal && (isSeller || country === 'SA') && !/^\d{5}$/.test(postal)) add(postalCode, `Found "${postal}"`);
  }

  function finish(): ValidationReport {
    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');
    return {
      valid: errors.length === 0,
      ...(kind !== undefined && { kind }),
      ...(documentType !== undefined && { documentType }),
      signed,
      ...(invoiceHash !== undefined && { invoiceHash }),
      errors,
      warnings,
      signatureChecks,
    };
  }
}

function isSha256Base64(s: string): boolean {
  try {
    return base64ToBytes(s).length === 32;
  } catch {
    return false;
  }
}
