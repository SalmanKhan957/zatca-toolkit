import { Decimal, sum } from './money.js';
import type { InvoiceInput, InvoiceLineInput, VatCategory, VatInfo } from './types.js';

export interface ResolvedVat {
  category: VatCategory;
  rate: Decimal;
  exemptionReasonCode?: string;
  exemptionReason?: string;
}

export interface ComputedLine {
  input: InvoiceLineInput;
  id: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discount: Decimal;
  /** quantity x unitPrice - discount, rounded to 2 dp (UBL LineExtensionAmount) */
  netAmount: Decimal;
  /** netAmount x rate, rounded to 2 dp */
  vatAmount: Decimal;
  /** netAmount + vatAmount (ZATCA line RoundingAmount) */
  amountWithVat: Decimal;
  vat: ResolvedVat;
}

export interface VatSubtotal {
  vat: ResolvedVat;
  taxableAmount: Decimal;
  taxAmount: Decimal;
}

export interface ComputedTotals {
  lines: ComputedLine[];
  /** Sum of line net amounts */
  lineExtensionAmount: Decimal;
  /** Sum of document-level allowances */
  allowanceTotalAmount: Decimal;
  /** lineExtensionAmount - allowanceTotalAmount */
  taxExclusiveAmount: Decimal;
  subtotals: VatSubtotal[];
  /** Sum of VAT subtotal amounts */
  taxAmount: Decimal;
  /** taxExclusiveAmount + taxAmount */
  taxInclusiveAmount: Decimal;
  prepaidAmount: Decimal;
  /** taxInclusiveAmount - prepaidAmount */
  payableAmount: Decimal;
}

export function resolveVat(v: VatInfo): ResolvedVat {
  const rate = Decimal.from(v.rate ?? (v.category === 'S' ? 15 : 0));
  return {
    category: v.category,
    rate,
    ...(v.exemptionReasonCode !== undefined && { exemptionReasonCode: v.exemptionReasonCode }),
    ...(v.exemptionReason !== undefined && { exemptionReason: v.exemptionReason }),
  };
}

function groupKey(v: ResolvedVat): string {
  return `${v.category}|${v.rate.toFixed(2)}|${v.exemptionReasonCode ?? ''}`;
}

/**
 * Compute every amount ZATCA cross-checks. Rounding is half-up to 2 decimals at the
 * line level and on each VAT category subtotal (EN 16931 BR-CO / BR-S rules).
 */
export function computeTotals(input: InvoiceInput): ComputedTotals {
  const lines: ComputedLine[] = input.lines.map((line, index) => {
    const quantity = Decimal.from(line.quantity);
    const unitPrice = Decimal.from(line.unitPrice);
    const discount = Decimal.from(line.discount?.amount ?? 0);
    const vat = resolveVat(line.vat);
    const netAmount = quantity.times(unitPrice).minus(discount).round(2);
    const vatAmount = netAmount.percent(vat.rate).round(2);
    return {
      input: line,
      id: line.id ?? String(index + 1),
      quantity,
      unitPrice,
      discount,
      netAmount,
      vatAmount,
      amountWithVat: netAmount.plus(vatAmount),
      vat,
    };
  });

  const allowances = (input.allowances ?? []).map((a) => ({
    amount: Decimal.from(a.amount).round(2),
    vat: resolveVat(a.vat),
  }));

  const groups = new Map<string, { vat: ResolvedVat; taxable: Decimal }>();
  const groupFor = (vat: ResolvedVat) => {
    const key = groupKey(vat);
    let g = groups.get(key);
    if (!g) {
      g = { vat, taxable: Decimal.zero() };
      groups.set(key, g);
    }
    return g;
  };
  for (const l of lines) {
    const g = groupFor(l.vat);
    g.taxable = g.taxable.plus(l.netAmount);
  }
  for (const a of allowances) {
    const g = groupFor(a.vat);
    g.taxable = g.taxable.minus(a.amount);
  }

  const subtotals: VatSubtotal[] = [...groups.values()].map((g) => ({
    vat: g.vat,
    taxableAmount: g.taxable.round(2),
    taxAmount: g.taxable.percent(g.vat.rate).round(2),
  }));

  const lineExtensionAmount = sum(lines.map((l) => l.netAmount));
  const allowanceTotalAmount = sum(allowances.map((a) => a.amount));
  const taxExclusiveAmount = lineExtensionAmount.minus(allowanceTotalAmount);
  const taxAmount = sum(subtotals.map((s) => s.taxAmount));
  const taxInclusiveAmount = taxExclusiveAmount.plus(taxAmount);
  const prepaidAmount = Decimal.from(input.prepaidAmount ?? 0).round(2);

  return {
    lines,
    lineExtensionAmount,
    allowanceTotalAmount,
    taxExclusiveAmount,
    subtotals,
    taxAmount,
    taxInclusiveAmount,
    prepaidAmount,
    payableAmount: taxInclusiveAmount.minus(prepaidAmount),
  };
}
