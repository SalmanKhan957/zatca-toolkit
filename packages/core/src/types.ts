/** Amounts and quantities: pass strings ("19.99") for exactness; numbers are accepted. */
export type Numeric = string | number;

/** Standard = B2B tax invoice (cleared in real time). Simplified = B2C (reported within 24h). */
export type InvoiceKind = 'standard' | 'simplified';

export type DocumentType = 'invoice' | 'credit-note' | 'debit-note';

/**
 * VAT category (UNCL5305 subset used by ZATCA):
 *  S = standard rate (15%), Z = zero-rated, E = exempt, O = out of scope.
 */
export type VatCategory = 'S' | 'Z' | 'E' | 'O';

/** Seller/buyer identification schemes accepted by ZATCA. */
export type PartyIdScheme =
  | 'CRN' // commercial registration number
  | 'MOM' // MOMRA licence
  | 'MLS' // MHRSD licence
  | '700' // 700 number
  | 'SAG' // MISA licence
  | 'OTH' // other
  | 'TIN' // tax identification number (buyer)
  | 'NAT' // national ID (buyer)
  | 'GCC' // GCC ID (buyer)
  | 'IQA' // iqama number (buyer)
  | 'PAS'; // passport (buyer)

export interface PartyIdentification {
  scheme: PartyIdScheme;
  value: string;
}

export interface Address {
  street: string;
  additionalStreet?: string;
  /** Saudi national address building number (4 digits) */
  buildingNumber: string;
  /** Saudi national address additional number (4 digits) - UBL PlotIdentification */
  additionalNumber?: string;
  /** District - UBL CitySubdivisionName */
  district: string;
  city: string;
  /** 5-digit postal code for Saudi addresses */
  postalCode: string;
  /** Region/province - UBL CountrySubentity */
  province?: string;
  /** ISO 3166-1 alpha-2, e.g. "SA" */
  country: string;
}

export interface Seller {
  /** Legal registration name (Arabic is fine) */
  name: string;
  /** 15-digit VAT registration number starting and ending with 3 */
  vatNumber: string;
  identification: PartyIdentification;
  address: Address;
}

export interface Buyer {
  name?: string;
  vatNumber?: string;
  identification?: PartyIdentification;
  address?: Partial<Address> & { country: string };
}

export interface VatInfo {
  category: VatCategory;
  /** Percentage, e.g. 15. Defaults to 15 for S and 0 otherwise. */
  rate?: Numeric;
  /** Required for Z/E/O, e.g. "VATEX-SA-32" */
  exemptionReasonCode?: string;
  exemptionReason?: string;
}

export interface InvoiceLineInput {
  id?: string;
  name: string;
  quantity: Numeric;
  /** UN/ECE Recommendation 20 unit code; defaults to "PCE" */
  unitCode?: string;
  /** Net unit price, excluding VAT */
  unitPrice: Numeric;
  /** Line-level discount amount (excluding VAT) */
  discount?: { amount: Numeric; reason?: string };
  vat: VatInfo;
}

export interface DocumentAllowanceInput {
  amount: Numeric;
  reason?: string;
  vat: VatInfo;
}

export interface InvoiceInput {
  kind: InvoiceKind;
  type?: DocumentType;
  /** Your invoice number (cbc:ID) */
  number: string;
  /** Generated automatically when omitted */
  uuid?: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** HH:mm:ss */
  issueTime: string;
  /** Defaults to SAR */
  currency?: string;
  seller: Seller;
  buyer?: Buyer;
  /** Supply (delivery) date, YYYY-MM-DD. Required on standard invoices. */
  supplyDate?: string;
  supplyEndDate?: string;
  /** UNTDID 4461 code: 10 cash, 30 credit transfer, 42 bank account, 48 card, 1 not defined */
  paymentMeansCode?: string;
  /** Invoice counter value (ICV): strictly increasing per device/solution */
  counter: number;
  /** Previous invoice hash (PIH). Omit for the first invoice to use ZATCA's initial value. */
  previousInvoiceHash?: string;
  /** For credit/debit notes: the original invoice number */
  billingReference?: string;
  /** For credit/debit notes: the reason for issuing it */
  reason?: string;
  note?: string;
  /** Purchase order number (cac:OrderReference) */
  orderReference?: string;
  /** Contract number (cac:ContractDocumentReference) */
  contractReference?: string;
  lines: InvoiceLineInput[];
  allowances?: DocumentAllowanceInput[];
  prepaidAmount?: Numeric;
  /** Transaction flags encoded in InvoiceTypeCode/@name positions 3-7 */
  flags?: InvoiceFlags;
  /** Required when `currency` is not SAR: SAR per 1 unit of the document currency */
  sarExchangeRate?: Numeric;
}

export interface InvoiceFlags {
  thirdParty?: boolean;
  nominal?: boolean;
  export?: boolean;
  summary?: boolean;
  /** Not allowed on simplified invoices */
  selfBilled?: boolean;
}
