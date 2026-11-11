import { describe, expect, it } from 'vitest';
import { computeTotals } from '../src/calc.js';
import type { InvoiceInput } from '../src/types.js';

const base: Omit<InvoiceInput, 'lines'> = {
  kind: 'simplified',
  number: 'INV-1',
  issueDate: '2026-11-10',
  issueTime: '14:05:00',
  counter: 1,
  seller: {
    name: 'Test Org',
    vatNumber: '399999999900003',
    identification: { scheme: 'CRN', value: '1010010000' },
    address: { street: 'King Fahd Rd', buildingNumber: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211', country: 'SA' },
  },
};

describe('computeTotals', () => {
  it('computes a single standard-rated line', () => {
    const t = computeTotals({ ...base, lines: [{ name: 'Widget', quantity: 2, unitPrice: '100', vat: { category: 'S' } }] });
    expect(t.lines[0]!.netAmount.toFixed()).toBe('200.00');
    expect(t.lines[0]!.vatAmount.toFixed()).toBe('30.00');
    expect(t.taxExclusiveAmount.toFixed()).toBe('200.00');
    expect(t.taxAmount.toFixed()).toBe('30.00');
    expect(t.taxInclusiveAmount.toFixed()).toBe('230.00');
    expect(t.payableAmount.toFixed()).toBe('230.00');
  });

  it('groups VAT by category and applies document allowances to their group', () => {
    const t = computeTotals({
      ...base,
      lines: [
        { name: 'Service', quantity: 1, unitPrice: '100', vat: { category: 'S' } },
        { name: 'Export', quantity: 1, unitPrice: '50', vat: { category: 'Z', exemptionReasonCode: 'VATEX-SA-32', exemptionReason: 'Export of goods' } },
      ],
      allowances: [{ amount: '10', reason: 'Loyalty', vat: { category: 'S' } }],
    });
    expect(t.subtotals).toHaveLength(2);
    const s = t.subtotals.find((x) => x.vat.category === 'S')!;
    expect(s.taxableAmount.toFixed()).toBe('90.00');
    expect(s.taxAmount.toFixed()).toBe('13.50');
    expect(t.lineExtensionAmount.toFixed()).toBe('150.00');
    expect(t.allowanceTotalAmount.toFixed()).toBe('10.00');
    expect(t.taxExclusiveAmount.toFixed()).toBe('140.00');
    expect(t.taxInclusiveAmount.toFixed()).toBe('153.50');
  });

  it('rounds line amounts half-up to halalas', () => {
    const t = computeTotals({ ...base, lines: [{ name: 'Fractional', quantity: 3, unitPrice: '33.333', vat: { category: 'S' } }] });
    expect(t.lines[0]!.netAmount.toFixed()).toBe('100.00');
    expect(t.taxAmount.toFixed()).toBe('15.00');
  });

  it('subtracts line discounts and prepayments', () => {
    const t = computeTotals({
      ...base,
      lines: [{ name: 'Laptop', quantity: 1, unitPrice: '4000', discount: { amount: '400' }, vat: { category: 'S' } }],
      prepaidAmount: '1000',
    });
    expect(t.lines[0]!.netAmount.toFixed()).toBe('3600.00');
    expect(t.taxInclusiveAmount.toFixed()).toBe('4140.00');
    expect(t.payableAmount.toFixed()).toBe('3140.00');
  });
});
