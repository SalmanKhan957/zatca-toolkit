import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CsidCredentials,
  FatooraApiError,
  FatooraClient,
  INITIAL_PREVIOUS_INVOICE_HASH,
  type InvoiceInput,
  type Seller,
  type SubmissionResult,
  type ValidationReport,
  type ZatcaEnvironment,
  buildInvoiceXml,
  computeInvoiceHash,
  decodeQr,
  egsSerialNumber,
  explainCode,
  generateCsr,
  generateKeyPair,
  privateKeyToPem,
  signInvoice,
  validateInvoice,
} from 'zatca-toolkit';
import { z } from 'zod';

export interface ServerConfig {
  environment: ZatcaEnvironment;
  privateKey?: string;
  certificate?: string;
  csidSecret?: string;
  seller?: Seller;
  /** JSON file that keeps the ICV counter and previous invoice hash between calls */
  stateFile: string;
  allowProduction: boolean;
}

/** Read configuration from environment variables (inline values or *_FILE paths). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const fromEnv = (name: string) => env[name] ?? (env[`${name}_FILE`] && existsSync(env[`${name}_FILE`]!) ? readFileSync(env[`${name}_FILE`]!, 'utf8') : undefined);
  const environment = (env.ZATCA_ENV ?? 'sandbox') as ZatcaEnvironment;
  if (!['sandbox', 'simulation', 'production'].includes(environment)) throw new Error(`ZATCA_ENV must be sandbox, simulation or production (got ${environment})`);
  const sellerJson = fromEnv('ZATCA_SELLER');
  return {
    environment,
    ...(fromEnv('ZATCA_PRIVATE_KEY') && { privateKey: fromEnv('ZATCA_PRIVATE_KEY')!.trim() }),
    ...(fromEnv('ZATCA_CERTIFICATE') && { certificate: fromEnv('ZATCA_CERTIFICATE')!.trim() }),
    ...(fromEnv('ZATCA_CSID_SECRET') && { csidSecret: fromEnv('ZATCA_CSID_SECRET')!.trim() }),
    ...(sellerJson && { seller: JSON.parse(sellerJson) as Seller }),
    stateFile: env.ZATCA_STATE_FILE ?? join(homedir(), '.zatca-toolkit', 'state.json'),
    allowProduction: env.ZATCA_ALLOW_PRODUCTION === '1',
  };
}

interface ChainState {
  counter: number;
  previousInvoiceHash: string;
}

function readState(file: string): ChainState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as ChainState;
    if (Number.isInteger(s.counter) && typeof s.previousInvoiceHash === 'string') return s;
  } catch {
    /* first run */
  }
  return { counter: 0, previousInvoiceHash: INITIAL_PREVIOUS_INVOICE_HASH };
}

function writeState(file: string, state: ChainState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

function loadXml(args: { xml?: string | undefined; path?: string | undefined }): string {
  if (args.xml) return args.xml;
  if (args.path) return readFileSync(resolve(args.path), 'utf8');
  throw new Error('Provide either `xml` (the document text) or `path` (a file path).');
}

export function formatReport(r: ValidationReport): string {
  const out: string[] = [];
  out.push(`${r.valid ? '✅ No errors' : '❌ Errors found'} — ${r.kind ?? 'unknown kind'} ${r.documentType ?? 'document'}, ${r.signed ? 'signed' : 'unsigned'}`);
  if (r.invoiceHash) out.push(`Invoice hash: ${r.invoiceHash}`);
  const section = (title: string, list: ValidationReport['errors']) => {
    if (list.length === 0) return;
    out.push('', `${title} (${list.length}):`);
    for (const f of list) {
      out.push(`- [${f.code}] ${f.message}${f.detail ? ` — ${f.detail}` : ''}`, `  ${f.messageAr}`);
      if (f.fix) out.push(`  Fix: ${f.fix}`);
    }
  };
  section('Errors (ZATCA would reject)', r.errors);
  section('Warnings (accepted, but should be fixed)', r.warnings);
  if (r.signatureChecks.length) {
    out.push('', 'Signature checks:');
    for (const c of r.signatureChecks) out.push(`- ${c.passed ? '✓' : '✗'} ${c.check}${!c.passed && c.detail ? ` (${c.detail})` : ''}`);
  }
  out.push('', 'Note: this is an offline pre-check of the most common rules, not ZATCA\'s official validator.');
  return out.join('\n');
}

function formatSubmission(r: SubmissionResult): string {
  const out = [
    `${r.accepted ? '✅ Accepted' : '❌ Not accepted'} — HTTP ${r.httpStatus}, status ${r.status}${r.reportingStatus ? `, ${r.reportingStatus}` : ''}${r.clearanceStatus ? `, ${r.clearanceStatus}` : ''}${r.duplicate ? ' (already submitted)' : ''}`,
  ];
  for (const [title, list] of [['Errors', r.errors], ['Warnings', r.warnings]] as const) {
    if (list.length) out.push(`${title}:`, ...list.map((m) => `- [${m.code}] ${m.message}${explainCode(m.code) ? `\n  Fix: ${explainCode(m.code)!.fix}` : ''}`));
  }
  if (r.clearedInvoiceXml) out.push('', 'ZATCA returned the cleared (stamped) invoice — share THIS version with the buyer:', r.clearedInvoiceXml);
  return out.join('\n');
}

const numeric = z.union([z.string(), z.number()]).describe('Decimal amount; strings like "19.99" are exact');
const vatCategory = z.enum(['S', 'Z', 'E', 'O']).describe('S = 15% standard, Z = zero-rated, E = exempt, O = out of scope');
const addressSchema = z.object({
  street: z.string(),
  additionalStreet: z.string().optional(),
  buildingNumber: z.string().describe('4 digits'),
  additionalNumber: z.string().optional(),
  district: z.string(),
  city: z.string(),
  postalCode: z.string().describe('5 digits'),
  province: z.string().optional(),
  country: z.string().default('SA'),
});
const sellerSchema = z.object({
  name: z.string(),
  vatNumber: z.string().describe('15 digits, starts and ends with 3'),
  identification: z.object({ scheme: z.enum(['CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH']), value: z.string() }),
  address: addressSchema,
});

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: 'zatca-toolkit', version: '0.1.0' });

  server.registerTool(
    'create_invoice',
    {
      title: 'Create a ZATCA e-invoice',
      description:
        'Build a ZATCA Phase 2 UBL invoice, credit note or debit note with exact VAT totals, and sign it (hash, ECDSA signature, XAdES, QR) when signing credentials are configured. ' +
        'Keeps the invoice counter (ICV) and previous-invoice-hash (PIH) chain in a local state file unless you pass them explicitly.',
      inputSchema: {
        kind: z.enum(['standard', 'simplified']).describe('standard = B2B tax invoice (cleared), simplified = B2C (reported)'),
        type: z.enum(['invoice', 'credit-note', 'debit-note']).default('invoice'),
        number: z.string().describe('Your invoice number'),
        issueDate: z.string().optional().describe('YYYY-MM-DD; defaults to today in KSA'),
        issueTime: z.string().optional().describe('HH:mm:ss; defaults to now in KSA'),
        seller: sellerSchema.optional().describe('Omit to use ZATCA_SELLER from the server configuration'),
        buyer: z
          .object({
            name: z.string().optional(),
            vatNumber: z.string().optional(),
            identification: z.object({ scheme: z.enum(['TIN', 'CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'OTH']), value: z.string() }).optional(),
            address: addressSchema.partial().extend({ country: z.string() }).optional(),
          })
          .optional(),
        supplyDate: z.string().optional().describe('YYYY-MM-DD; required for standard invoices'),
        paymentMeansCode: z.string().optional().describe('10 cash, 30 credit transfer, 42 bank account, 48 card'),
        billingReference: z.string().optional().describe('Original invoice number (credit/debit notes)'),
        reason: z.string().optional().describe('Reason for a credit/debit note'),
        note: z.string().optional(),
        lines: z
          .array(
            z.object({
              name: z.string(),
              quantity: numeric,
              unitPrice: numeric.describe('Net unit price excluding VAT'),
              unitCode: z.string().optional(),
              discount: numeric.optional().describe('Line discount amount'),
              vatCategory: vatCategory.default('S'),
              vatRate: numeric.optional(),
              exemptionReasonCode: z.string().optional().describe('e.g. VATEX-SA-32 for exports; required for Z/E/O'),
              exemptionReason: z.string().optional(),
            }),
          )
          .min(1),
        counter: z.number().int().positive().optional().describe('ICV; omit to use the local chain state'),
        previousInvoiceHash: z.string().optional().describe('PIH; omit to use the local chain state'),
        sign: z.boolean().default(true).describe('Sign if credentials are configured'),
        outputPath: z.string().optional().describe('Write the XML to this file instead of returning it inline'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const seller = args.seller ?? config.seller;
        if (!seller) return fail('No seller details: pass `seller` or set ZATCA_SELLER in the server configuration.');
        const ksa = new Date(Date.now() + 3 * 3600_000).toISOString();
        const useState = args.counter === undefined || args.previousInvoiceHash === undefined;
        const state = useState ? readState(config.stateFile) : undefined;
        const input: InvoiceInput = {
          kind: args.kind,
          type: args.type,
          number: args.number,
          issueDate: args.issueDate ?? ksa.slice(0, 10),
          issueTime: args.issueTime ?? ksa.slice(11, 19),
          seller: seller as Seller,
          ...(args.buyer && { buyer: args.buyer as InvoiceInput['buyer'] }),
          ...(args.supplyDate && { supplyDate: args.supplyDate }),
          ...(args.paymentMeansCode && { paymentMeansCode: args.paymentMeansCode }),
          ...(args.billingReference && { billingReference: args.billingReference }),
          ...(args.reason && { reason: args.reason }),
          ...(args.note && { note: args.note }),
          counter: args.counter ?? state!.counter + 1,
          previousInvoiceHash: args.previousInvoiceHash ?? state!.previousInvoiceHash,
          lines: args.lines.map((l) => ({
            name: l.name,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            ...(l.unitCode && { unitCode: l.unitCode }),
            ...(l.discount !== undefined && { discount: { amount: l.discount } }),
            vat: {
              category: l.vatCategory,
              ...(l.vatRate !== undefined && { rate: l.vatRate }),
              ...(l.exemptionReasonCode && { exemptionReasonCode: l.exemptionReasonCode }),
              ...(l.exemptionReason && { exemptionReason: l.exemptionReason }),
            },
          })),
        };
        const built = buildInvoiceXml(input);
        const canSign = args.sign && !!config.privateKey && !!config.certificate;
        const result = canSign ? signInvoice(built.xml, { privateKey: config.privateKey!, certificate: config.certificate! }) : undefined;
        const xml = result?.xml ?? built.xml;
        const hash = result?.invoiceHash ?? computeInvoiceHash(xml);
        if (useState) writeState(config.stateFile, { counter: input.counter, previousInvoiceHash: hash });
        if (args.outputPath) writeFileSync(resolve(args.outputPath), xml);

        const t = built.totals;
        const summary = [
          `${result ? 'Signed' : 'Unsigned'} ${input.kind} ${input.type ?? 'invoice'} ${input.number} (ICV ${input.counter}, UUID ${built.uuid})`,
          `Net ${t.taxExclusiveAmount.toFixed()} + VAT ${t.taxAmount.toFixed()} = ${t.taxInclusiveAmount.toFixed()} ${input.currency ?? 'SAR'}`,
          `Invoice hash: ${hash}`,
          ...(result ? [`QR payload: ${result.qr}`] : []),
          ...(!result && args.sign ? ['Not signed: set ZATCA_PRIVATE_KEY and ZATCA_CERTIFICATE to sign. Simplified invoices must be signed before sharing.'] : []),
          '',
          args.outputPath ? `XML written to ${resolve(args.outputPath)}` : xml,
        ];
        return text(summary.join('\n'));
      } catch (e) {
        return fail(`Could not create the invoice: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'validate_invoice',
    {
      title: 'Validate a ZATCA e-invoice',
      description:
        'Check a ZATCA XML invoice offline: common BR-KSA/EN16931 rules, totals arithmetic, and for signed documents the invoice hash, ECDSA signature, XAdES digests and every QR tag. Explains each problem in English and Arabic with a fix.',
      inputSchema: { xml: z.string().optional().describe('The XML text'), path: z.string().optional().describe('Or a path to the XML file') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return text(formatReport(validateInvoice(loadXml(args))));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'decode_qr',
    {
      title: 'Decode a ZATCA QR code',
      description: 'Decode the base64 TLV payload of a ZATCA e-invoice QR code into its fields (seller, VAT number, timestamp, totals, hash, signature, key). Flags non-BER lengths that ZATCA rejects.',
      inputSchema: { qr: z.string().describe('Base64 QR payload (the text inside the QR image)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ qr }) => {
      try {
        const { tags, warnings } = decodeQr(qr);
        const names: Record<number, string> = { 1: 'Seller name', 2: 'VAT number', 3: 'Timestamp', 4: 'Total with VAT', 5: 'VAT total', 6: 'Invoice hash', 7: 'Signature', 8: 'Public key (DER, base64)', 9: 'Certificate signature (DER, base64)' };
        const lines = tags.map((t) => `${t.tag}. ${names[t.tag] ?? 'Unknown tag'} (${t.length} bytes): ${t.value}`);
        if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
        lines.push('', tags.length >= 8 ? 'Phase 2 QR (signed).' : 'Phase 1 QR (tags 1-5 only): not valid for Phase 2 integration.');
        return text(lines.join('\n'));
      } catch (e) {
        return fail(`Not a valid ZATCA QR payload: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'explain_error',
    {
      title: 'Explain a ZATCA error',
      description: 'Explain ZATCA rule codes or API error messages (e.g. "BR-KSA-37", "invalid-invoice-hash", or a pasted API response) in plain English and Arabic, with the fix.',
      inputSchema: { error: z.string().describe('A code, a message, or a whole API response') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ error }) => {
      const codes = [...new Set(error.match(/BR-[A-Z0-9-]+|[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*_QRCODE_INVALID|[a-zA-Z]+(?:-[A-Za-z0-9]+)+/g) ?? [])];
      const hits = codes.map((c) => explainCode(c)).filter((e): e is NonNullable<typeof e> => !!e);
      if (hits.length === 0) {
        return text(`No catalogue entry for: ${error}\nFor BR-KSA codes not listed here, see ZATCA's "Electronic Invoice XML Implementation Standard" and the SDK schematron (Data/Rules/Schematrons).`);
      }
      return text(hits.map((h) => `[${h.code}] (${h.severity})\n${h.en}\n${h.ar}\nFix: ${h.fix}`).join('\n\n'));
    },
  );

  server.registerTool(
    'compute_invoice_hash',
    {
      title: 'Compute a ZATCA invoice hash',
      description: 'Compute the ZATCA invoice hash (base64 SHA-256 of the canonicalized XML without UBLExtensions, Signature and QR). Use it to debug "invalid-invoice-hash" or as the next PIH.',
      inputSchema: { xml: z.string().optional(), path: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return text(computeInvoiceHash(loadXml(args)));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'generate_csr',
    {
      title: 'Generate a ZATCA key pair and CSR',
      description:
        'Create a secp256k1 private key (written to a file, never shown) and the CSR needed to onboard an e-invoicing unit (EGS) with ZATCA. Returns the CSR and the exact value to send to POST /compliance.',
      inputSchema: {
        commonName: z.string().describe('Unique name of the EGS unit'),
        solutionName: z.string(),
        modelOrVersion: z.string(),
        deviceSerial: z.string(),
        vatNumber: z.string(),
        organizationUnit: z.string().describe('Branch name (or 10-digit TIN for VAT group members)'),
        organizationName: z.string(),
        invoiceType: z.enum(['1100', '1000', '0100']).describe('1100 both, 1000 standard only, 0100 simplified only'),
        location: z.string().describe('Branch address / national short address'),
        industry: z.string(),
        environment: z.enum(['sandbox', 'simulation', 'production']).optional(),
        keyOutputPath: z.string().describe('Where to write the private key (keep it secret)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const keyPath = resolve(a.keyOutputPath);
        if (existsSync(keyPath)) return fail(`${keyPath} already exists; refusing to overwrite a private key.`);
        const { privateKey } = generateKeyPair();
        const csr = generateCsr(
          {
            commonName: a.commonName,
            serialNumber: egsSerialNumber(a.solutionName, a.modelOrVersion, a.deviceSerial),
            vatNumber: a.vatNumber,
            organizationUnit: a.organizationUnit,
            organizationName: a.organizationName,
            invoiceType: a.invoiceType,
            location: a.location,
            industry: a.industry,
            environment: a.environment ?? config.environment,
          },
          privateKey,
        );
        mkdirSync(dirname(keyPath), { recursive: true });
        writeFileSync(keyPath, privateKeyToPem(privateKey), { mode: 0o600 });
        return text(
          [
            `Private key written to ${keyPath} (keep it secret; never share it).`,
            '',
            csr.pem,
            'Value for the `csr` field of POST /compliance:',
            csr.apiValue,
          ].join('\n'),
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'submit_invoice',
    {
      title: 'Submit an invoice to ZATCA',
      description:
        'Send a signed invoice to ZATCA\'s Fatoora API using the configured CSID: "report" (simplified/B2C), "clear" (standard/B2B, returns the stamped invoice) or "compliance" (onboarding checks). ' +
        'Uses ZATCA_ENV (sandbox by default). Production submissions are real tax filings and require ZATCA_ALLOW_PRODUCTION=1.',
      inputSchema: {
        mode: z.enum(['report', 'clear', 'compliance']),
        xml: z.string().optional(),
        path: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (config.environment === 'production' && !config.allowProduction) {
          return fail('Refusing to submit to PRODUCTION: set ZATCA_ALLOW_PRODUCTION=1 if you really mean to file real invoices.');
        }
        if (!config.certificate || !config.csidSecret) {
          return fail('Set ZATCA_CERTIFICATE (the binarySecurityToken) and ZATCA_CSID_SECRET to submit.');
        }
        const xml = loadXml(args);
        const report = validateInvoice(xml);
        if (!report.valid) return fail(`Not submitted: the invoice has errors.\n\n${formatReport(report)}`);
        const uuid = /<cbc:UUID>([^<]+)<\/cbc:UUID>/.exec(xml)?.[1] ?? '';
        const doc = { xml, invoiceHash: computeInvoiceHash(xml), uuid };
        const creds: CsidCredentials = { binarySecurityToken: config.certificate, secret: config.csidSecret };
        const client = new FatooraClient({ environment: config.environment });
        const result =
          args.mode === 'report' ? await client.reportInvoice(creds, doc) : args.mode === 'clear' ? await client.clearInvoice(creds, doc) : await client.checkCompliance(creds, doc);
        return text(`[${config.environment}] ${formatSubmission(result)}`);
      } catch (e) {
        if (e instanceof FatooraApiError) return fail(`${e.message}${e.errors.map((m) => (explainCode(m.code) ? `\nFix: ${explainCode(m.code)!.fix}` : '')).join('')}`);
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
