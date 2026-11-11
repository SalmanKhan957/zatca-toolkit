import type { InvoiceInput } from '../../src/types.js';

/** Mirrors ZATCA's official Simplified_Invoice.xml sample (same parties, lines and totals). */
export const sampleInput: InvoiceInput = {
  kind: 'simplified',
  number: 'SME00099',
  uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
  issueDate: '2026-11-10',
  issueTime: '14:05:00',
  counter: 1,
  seller: {
    name: 'شركة توريد التكنولوجيا بأقصى سرعة المحدودة | Maximum Speed Tech Supply LTD',
    vatNumber: '399999999900003',
    identification: { scheme: 'CRN', value: '1010010000' },
    address: { street: 'الامير سلطان | Prince Sultan', buildingNumber: '2322', district: 'المربع | Al-Murabba', city: 'الرياض | Riyadh', postalCode: '23333', country: 'SA' },
  },
  paymentMeansCode: '10',
  lines: [
    { name: 'كتاب', quantity: 33, unitPrice: '3.00', vat: { category: 'S' } },
    { name: 'قلم', quantity: 3, unitPrice: '34.00', vat: { category: 'S' } },
  ],
};
