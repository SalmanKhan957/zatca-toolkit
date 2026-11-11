/**
 * End-to-end run against ZATCA's public developer-portal sandbox (dummy data only):
 *   keys + CSR -> compliance CSID -> 6 compliance documents -> production CSID
 *   -> report a simplified invoice -> clear a standard invoice.
 *
 * Run: npx tsx scripts/sandbox-e2e.ts
 */
import { FatooraClient, SANDBOX_OTP, type CsidCredentials, type SubmissionResult } from '../src/api.js';
import { egsSerialNumber, generateCsr } from '../src/csr.js';
import { INITIAL_PREVIOUS_INVOICE_HASH } from '../src/hash.js';
import { generateKeyPair, privateKeyToPem } from '../src/keys.js';
import { signInvoice } from '../src/sign.js';
import type { DocumentType, InvoiceInput, InvoiceKind } from '../src/types.js';
import { buildInvoiceXml } from '../src/xml-builder.js';

const VAT = '399999999900003';
const client = new FatooraClient({ environment: 'sandbox' });

function ksaNow() {
  const d = new Date(Date.now() + 3 * 3600_000 - 60_000); // KSA = UTC+3, minus a minute of clock-skew margin
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

let counter = 0;
let pih = INITIAL_PREVIOUS_INVOICE_HASH;

function makeDocument(kind: InvoiceKind, type: DocumentType, key: string, certificate: string) {
  counter += 1;
  const { date, time } = ksaNow();
  const input: InvoiceInput = {
    kind,
    type,
    number: `E2E-${Date.now()}-${counter}`,
    issueDate: date,
    issueTime: time,
    counter,
    previousInvoiceHash: pih,
    paymentMeansCode: '10',
    seller: {
      name: 'Maximum Speed Tech Supply LTD',
      vatNumber: VAT,
      identification: { scheme: 'CRN', value: '1010010000' },
      address: { street: 'Prince Sultan', buildingNumber: '2322', district: 'Al-Murabba', city: 'Riyadh', postalCode: '23333', country: 'SA' },
    },
    ...(kind === 'standard' && {
      supplyDate: date,
      buyer: {
        name: 'Fatoora Samples LTD',
        vatNumber: '399999999800003',
        address: { street: 'Salah Al-Din', buildingNumber: '1111', district: 'Al-Murooj', city: 'Riyadh', postalCode: '12222', country: 'SA' },
      },
    }),
    ...(type !== 'invoice' && { billingReference: 'SME00001', reason: 'Goods returned | ترجيع السلع' }),
    lines: [
      { name: 'كتاب | Book', quantity: 2, unitPrice: '50.00', vat: { category: 'S' } },
      { name: 'Export service', quantity: 1, unitPrice: '100.00', vat: { category: 'Z', exemptionReasonCode: 'VATEX-SA-33', exemptionReason: 'Export of services' } },
    ],
  };
  const { xml } = buildInvoiceXml(input);
  const signed = signInvoice(xml, { privateKey: key, certificate });
  pih = signed.invoiceHash;
  return signed;
}

function show(label: string, r: SubmissionResult) {
  const status = r.reportingStatus ?? r.clearanceStatus ?? '';
  console.log(`  ${r.accepted ? 'OK ' : 'ERR'} ${label}: HTTP ${r.httpStatus} ${r.status} ${status}${r.duplicate ? ' (duplicate)' : ''}`);
  for (const m of [...r.errors, ...r.warnings]) console.log(`      ${m.code}: ${m.message}`);
}

async function main() {
  console.log('1. Key pair + CSR');
  const { privateKey } = generateKeyPair();
  const keyPem = privateKeyToPem(privateKey);
  const csr = generateCsr(
    {
      commonName: `TST-E2E-${VAT}`,
      serialNumber: egsSerialNumber('ZatcaToolkit', '0.1', globalThis.crypto.randomUUID()),
      vatNumber: VAT,
      organizationUnit: 'Riyadh Branch',
      organizationName: 'Maximum Speed Tech Supply LTD',
      invoiceType: '1100',
      location: 'RRRD2929',
      industry: 'Supply activities',
      environment: 'sandbox',
    },
    privateKey,
  );

  console.log('2. Compliance CSID (POST /compliance)');
  const ccsid = await client.requestComplianceCsid(csr.apiValue, SANDBOX_OTP);
  console.log(`  disposition=${ccsid.dispositionMessage} requestID=${ccsid.requestID}`);
  const ccsidCreds: CsidCredentials = ccsid;

  console.log('3. Compliance checks (POST /compliance/invoices)');
  let allOk = true;
  for (const kind of ['standard', 'simplified'] as const) {
    for (const type of ['invoice', 'credit-note', 'debit-note'] as const) {
      const doc = makeDocument(kind, type, keyPem, ccsid.binarySecurityToken);
      const r = await client.checkCompliance(ccsidCreds, doc);
      show(`${kind} ${type}`, r);
      allOk &&= r.accepted;
    }
  }

  console.log('4. Production CSID (POST /production/csids)');
  const pcsid = await client.requestProductionCsid(ccsidCreds, ccsid.requestID);
  console.log(`  disposition=${pcsid.dispositionMessage}`);

  console.log('5. Reporting + clearance with the production CSID');
  // The sandbox issues ZATCA's fixed dummy PCSID, whose key is published in the SDK.
  const sandboxPcsidKey =
    'MHQCAQEEIL14JV+5nr/sE8Sppaf2IySovrhVBtt8+yz+g4NRKyz8oAcGBSuBBAAKoUQDQgAEoWCKa0Sa9FIErTOv0uAkC1VIKXxU9nPpx2vlf4yhMejy8c02XJblDq7tPydo8mq0ahOMmNo8gwni7Xt1KT9UeA==';
  for (const [key, label] of [[keyPem, 'our key'], [sandboxPcsidKey, 'SDK dummy key']] as const) {
    try {
      const simplified = makeDocument('simplified', 'invoice', key, pcsid.binarySecurityToken);
      show(`report simplified (${label})`, await client.reportInvoice(pcsid, simplified));
      const standard = makeDocument('standard', 'invoice', key, pcsid.binarySecurityToken);
      const cleared = await client.clearInvoice(pcsid, standard);
      show(`clear standard (${label})`, cleared);
      if (cleared.clearedInvoiceXml) console.log(`      cleared invoice returned (${cleared.clearedInvoiceXml.length} chars)`);
      break;
    } catch (e) {
      console.log(`  (${label}) ${(e as Error).message}`);
    }
  }
  console.log(allOk ? '\nAll compliance checks passed.' : '\nSome compliance checks failed.');
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
