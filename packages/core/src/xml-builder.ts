import { type ComputedTotals, type ResolvedVat, computeTotals } from './calc.js';
import { NS } from './dom.js';
import { INITIAL_PREVIOUS_INVOICE_HASH } from './hash.js';
import { Decimal } from './money.js';
import type { Address, Buyer, InvoiceInput, Seller } from './types.js';

/** Minimal element tree, rendered with the SDK's 4-space indentation and LF line endings. */
interface XmlEl {
  name: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: Array<XmlEl | false | undefined | null>;
}

const el = (name: string, attrsOrText?: Record<string, string> | string, ...children: Array<XmlEl | false | undefined | null>): XmlEl => {
  if (typeof attrsOrText === 'string') return { name, text: attrsOrText };
  return { name, ...(attrsOrText && { attrs: attrsOrText }), children };
};
const leaf = (name: string, text: string, attrs?: Record<string, string>): XmlEl => ({ name, text, ...(attrs && { attrs }) });

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function render(node: XmlEl, depth: number, out: string[]): void {
  const pad = '    '.repeat(depth);
  const attrs = node.attrs ? Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('') : '';
  if (node.text !== undefined) {
    out.push(`${pad}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>`);
    return;
  }
  const kids = (node.children ?? []).filter((c): c is XmlEl => !!c);
  if (kids.length === 0) {
    // Empty containers are written as an open/close pair on two lines, as in the SDK samples.
    out.push(`${pad}<${node.name}${attrs}>`, `${pad}</${node.name}>`);
    return;
  }
  out.push(`${pad}<${node.name}${attrs}>`);
  for (const k of kids) render(k, depth + 1, out);
  out.push(`${pad}</${node.name}>`);
}

const TYPE_CODES = { invoice: '388', 'credit-note': '381', 'debit-note': '383' } as const;

/** InvoiceTypeCode/@name: NN (01 standard, 02 simplified) + P N E S B flags. */
export function transactionCode(input: InvoiceInput): string {
  const f = input.flags ?? {};
  const bit = (b?: boolean) => (b ? '1' : '0');
  return `${input.kind === 'standard' ? '01' : '02'}${bit(f.thirdParty)}${bit(f.nominal)}${bit(f.export)}${bit(f.summary)}${bit(f.selfBilled)}`;
}

function amount(name: string, value: Decimal, currency: string): XmlEl {
  return leaf(name, value.toFixed(2), { currencyID: currency });
}

function address(a: Partial<Address> & { country: string }): XmlEl {
  return el(
    'cac:PostalAddress',
    {},
    a.street !== undefined && leaf('cbc:StreetName', a.street),
    a.additionalStreet !== undefined && leaf('cbc:AdditionalStreetName', a.additionalStreet),
    a.buildingNumber !== undefined && leaf('cbc:BuildingNumber', a.buildingNumber),
    a.additionalNumber !== undefined && leaf('cbc:PlotIdentification', a.additionalNumber),
    a.district !== undefined && leaf('cbc:CitySubdivisionName', a.district),
    a.city !== undefined && leaf('cbc:CityName', a.city),
    a.postalCode !== undefined && leaf('cbc:PostalZone', a.postalCode),
    a.province !== undefined && leaf('cbc:CountrySubentity', a.province),
    el('cac:Country', {}, leaf('cbc:IdentificationCode', a.country)),
  );
}

function taxScheme(withSchemeIds: boolean): XmlEl {
  return el('cac:TaxScheme', {}, leaf('cbc:ID', 'VAT', withSchemeIds ? { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' } : undefined));
}

function taxCategory(name: string, vat: ResolvedVat, opts: { schemeIds: boolean; exemption: boolean }): XmlEl {
  return el(
    name,
    {},
    leaf('cbc:ID', vat.category, opts.schemeIds ? { schemeID: 'UN/ECE 5305', schemeAgencyID: '6' } : undefined),
    leaf('cbc:Percent', vat.rate.toFixed(2)),
    opts.exemption && vat.exemptionReasonCode !== undefined && leaf('cbc:TaxExemptionReasonCode', vat.exemptionReasonCode),
    opts.exemption && vat.exemptionReason !== undefined && leaf('cbc:TaxExemptionReason', vat.exemptionReason),
    taxScheme(opts.schemeIds),
  );
}

function supplierParty(s: Seller): XmlEl {
  return el(
    'cac:AccountingSupplierParty',
    {},
    el(
      'cac:Party',
      {},
      el('cac:PartyIdentification', {}, leaf('cbc:ID', s.identification.value, { schemeID: s.identification.scheme })),
      address(s.address),
      el('cac:PartyTaxScheme', {}, leaf('cbc:CompanyID', s.vatNumber), taxScheme(false)),
      el('cac:PartyLegalEntity', {}, leaf('cbc:RegistrationName', s.name)),
    ),
  );
}

function customerParty(b: Buyer | undefined): XmlEl {
  if (!b) return el('cac:AccountingCustomerParty', {});
  return el(
    'cac:AccountingCustomerParty',
    {},
    el(
      'cac:Party',
      {},
      b.identification && el('cac:PartyIdentification', {}, leaf('cbc:ID', b.identification.value, { schemeID: b.identification.scheme })),
      b.address && address(b.address),
      b.vatNumber !== undefined && el('cac:PartyTaxScheme', {}, leaf('cbc:CompanyID', b.vatNumber), taxScheme(false)),
      b.name !== undefined && el('cac:PartyLegalEntity', {}, leaf('cbc:RegistrationName', b.name)),
    ),
  );
}

export interface BuiltInvoice {
  /** Unsigned UBL XML. Pass it to signInvoice(), or submit standard invoices for clearance as-is. */
  xml: string;
  uuid: string;
  totals: ComputedTotals;
}

/**
 * Build the unsigned ZATCA UBL 2.1 XML for an invoice, credit note or debit note.
 * Amounts are computed with exact decimal arithmetic (see computeTotals).
 */
export function buildInvoiceXml(input: InvoiceInput): BuiltInvoice {
  const type = input.type ?? 'invoice';
  const currency = input.currency ?? 'SAR';
  const uuid = input.uuid ?? globalThis.crypto.randomUUID();
  const totals = computeTotals(input);
  const isNote = type !== 'invoice';

  if (isNote && !input.billingReference) throw new Error('Credit and debit notes need `billingReference` (the original invoice number).');
  if (isNote && !input.reason) throw new Error('Credit and debit notes need a `reason` (KSA-10).');
  if (currency !== 'SAR' && input.sarExchangeRate === undefined) {
    throw new Error(`Invoices in ${currency} need \`sarExchangeRate\`: ZATCA requires the VAT total in SAR as well.`);
  }
  const taxAmountSar = currency === 'SAR' ? totals.taxAmount : totals.taxAmount.times(Decimal.from(input.sarExchangeRate!)).round(2);

  const paymentMeans =
    (input.paymentMeansCode !== undefined || isNote) &&
    el(
      'cac:PaymentMeans',
      {},
      leaf('cbc:PaymentMeansCode', input.paymentMeansCode ?? '1'),
      isNote && leaf('cbc:InstructionNote', input.reason!),
    );

  const allowances = (input.allowances ?? []).map((a) => {
    const vat = totals.subtotals.find((s) => s.vat.category === a.vat.category)?.vat;
    return el(
      'cac:AllowanceCharge',
      {},
      leaf('cbc:ChargeIndicator', 'false'),
      leaf('cbc:AllowanceChargeReason', a.reason ?? 'discount'),
      amount('cbc:Amount', Decimal.from(a.amount).round(2), currency),
      taxCategory('cac:TaxCategory', vat ?? { category: a.vat.category, rate: Decimal.from(a.vat.rate ?? (a.vat.category === 'S' ? 15 : 0)) }, { schemeIds: true, exemption: false }),
    );
  });

  const root = el(
    'Invoice',
    { xmlns: NS.invoice, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext },
    leaf('cbc:ProfileID', 'reporting:1.0'),
    leaf('cbc:ID', input.number),
    leaf('cbc:UUID', uuid),
    leaf('cbc:IssueDate', input.issueDate),
    leaf('cbc:IssueTime', input.issueTime),
    leaf('cbc:InvoiceTypeCode', TYPE_CODES[type], { name: transactionCode(input) }),
    input.note !== undefined && leaf('cbc:Note', input.note),
    leaf('cbc:DocumentCurrencyCode', currency),
    leaf('cbc:TaxCurrencyCode', 'SAR'),
    input.orderReference !== undefined && el('cac:OrderReference', {}, leaf('cbc:ID', input.orderReference)),
    isNote && el('cac:BillingReference', {}, el('cac:InvoiceDocumentReference', {}, leaf('cbc:ID', input.billingReference!))),
    input.contractReference !== undefined && el('cac:ContractDocumentReference', {}, leaf('cbc:ID', input.contractReference)),
    el('cac:AdditionalDocumentReference', {}, leaf('cbc:ID', 'ICV'), leaf('cbc:UUID', String(input.counter))),
    el(
      'cac:AdditionalDocumentReference',
      {},
      leaf('cbc:ID', 'PIH'),
      el('cac:Attachment', {}, leaf('cbc:EmbeddedDocumentBinaryObject', input.previousInvoiceHash ?? INITIAL_PREVIOUS_INVOICE_HASH, { mimeCode: 'text/plain' })),
    ),
    supplierParty(input.seller),
    customerParty(input.buyer),
    input.supplyDate !== undefined &&
      el('cac:Delivery', {}, leaf('cbc:ActualDeliveryDate', input.supplyDate), input.supplyEndDate !== undefined && leaf('cbc:LatestDeliveryDate', input.supplyEndDate)),
    paymentMeans,
    ...allowances,
    el('cac:TaxTotal', {}, amount('cbc:TaxAmount', taxAmountSar, 'SAR')),
    el(
      'cac:TaxTotal',
      {},
      amount('cbc:TaxAmount', totals.taxAmount, currency),
      ...totals.subtotals.map((s) =>
        el(
          'cac:TaxSubtotal',
          {},
          amount('cbc:TaxableAmount', s.taxableAmount, currency),
          amount('cbc:TaxAmount', s.taxAmount, currency),
          taxCategory('cac:TaxCategory', s.vat, { schemeIds: true, exemption: true }),
        ),
      ),
    ),
    el(
      'cac:LegalMonetaryTotal',
      {},
      amount('cbc:LineExtensionAmount', totals.lineExtensionAmount, currency),
      amount('cbc:TaxExclusiveAmount', totals.taxExclusiveAmount, currency),
      amount('cbc:TaxInclusiveAmount', totals.taxInclusiveAmount, currency),
      amount('cbc:AllowanceTotalAmount', totals.allowanceTotalAmount, currency),
      amount('cbc:PrepaidAmount', totals.prepaidAmount, currency),
      amount('cbc:PayableAmount', totals.payableAmount, currency),
    ),
    ...totals.lines.map((l) =>
      el(
        'cac:InvoiceLine',
        {},
        leaf('cbc:ID', l.id),
        leaf('cbc:InvoicedQuantity', l.quantity.toString(), { unitCode: l.input.unitCode ?? 'PCE' }),
        amount('cbc:LineExtensionAmount', l.netAmount, currency),
        !l.discount.isZero() &&
          el(
            'cac:AllowanceCharge',
            {},
            leaf('cbc:ChargeIndicator', 'false'),
            leaf('cbc:AllowanceChargeReason', l.input.discount?.reason ?? 'discount'),
            amount('cbc:Amount', l.discount.round(2), currency),
          ),
        el('cac:TaxTotal', {}, amount('cbc:TaxAmount', l.vatAmount, currency), amount('cbc:RoundingAmount', l.amountWithVat, currency)),
        el('cac:Item', {}, leaf('cbc:Name', l.input.name), taxCategory('cac:ClassifiedTaxCategory', l.vat, { schemeIds: false, exemption: false })),
        el('cac:Price', {}, leaf('cbc:PriceAmount', l.unitPrice.toString(2), { currencyID: currency })),
      ),
    ),
  );

  const lines: string[] = [];
  render(root, 0, lines);
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${lines.join('\n')}\n`, uuid, totals };
}
