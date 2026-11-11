import type { ZatcaEnvironment } from './csr.js';
import { bytesToBase64, utf8Encode } from './encoding.js';
import { fromApiInvoicePayload, toApiInvoicePayload } from './sign.js';

export const FATOORA_BASE_URLS: Record<ZatcaEnvironment, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

/** The developer-portal sandbox accepts this OTP for POST /compliance (documented by ZATCA). */
export const SANDBOX_OTP = '123345';

export interface CsidCredentials {
  /** Use exactly as returned by ZATCA (it is base64 of the base64 certificate). */
  binarySecurityToken: string;
  secret: string;
}

export interface CsidResponse extends CsidCredentials {
  requestID: string;
  dispositionMessage: string;
  tokenType?: string;
}

export interface ValidationMessage {
  type?: string;
  code: string;
  category?: string;
  message: string;
  status?: string;
}

export interface SubmissionResult {
  httpStatus: number;
  /** Overall validation status reported by ZATCA */
  status: 'PASS' | 'WARNING' | 'ERROR' | 'UNKNOWN';
  /** True when ZATCA reported/cleared the document (including idempotent duplicates) */
  accepted: boolean;
  /** True for 409 (already reported) / 208 (hash previously submitted) */
  duplicate: boolean;
  reportingStatus?: string;
  clearanceStatus?: string;
  /** Decoded XML of the ZATCA-stamped invoice returned by clearance; give this version to the buyer */
  clearedInvoiceXml?: string;
  info: ValidationMessage[];
  warnings: ValidationMessage[];
  errors: ValidationMessage[];
  raw: unknown;
}

export interface SubmittableDocument {
  /** The exact signed (or, for clearance, optionally unsigned) XML */
  xml: string;
  invoiceHash: string;
  uuid: string;
}

export class FatooraApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly errors: ValidationMessage[],
    readonly raw: unknown,
  ) {
    super(message);
  }
}

export interface FatooraClientOptions {
  environment: ZatcaEnvironment;
  /** Override the base URL (e.g. a proxy) */
  baseUrl?: string;
  /** Custom fetch (defaults to globalThis.fetch). The API does not allow browser CORS: call it server-side. */
  fetch?: typeof fetch;
  /** Per-request timeout; ZATCA's gateway can be slow. Default 90s. */
  timeoutMs?: number;
  /** Retries for network errors and 5xx (submissions are idempotent by UUID + hash). Default 2. */
  retries?: number;
  language?: 'en' | 'ar';
}

/**
 * Typed client for ZATCA's Fatoora e-invoicing API (onboarding, compliance checks,
 * reporting, clearance), normalising the quirks of the live service:
 * both error formats, the `erroMessages` spelling, objects-instead-of-arrays,
 * 409/208 duplicates, 303 clearance-disabled, and NOT_COMPLIANT on renewal.
 */
export class FatooraClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly language: 'en' | 'ar';

  constructor(options: FatooraClientOptions) {
    this.baseUrl = (options.baseUrl ?? FATOORA_BASE_URLS[options.environment]).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.retries = options.retries ?? 2;
    this.language = options.language ?? 'en';
  }

  /** Step 1 of onboarding: exchange a CSR + OTP for a compliance CSID. */
  async requestComplianceCsid(csrApiValue: string, otp: string): Promise<CsidResponse> {
    const res = await this.request('POST', '/compliance', { csr: csrApiValue }, { OTP: otp });
    return this.csid(res);
  }

  /** Step 2: submit a signed sample document with the compliance CSID. */
  async checkCompliance(credentials: CsidCredentials, doc: SubmittableDocument): Promise<SubmissionResult> {
    const res = await this.request('POST', '/compliance/invoices', this.invoiceBody(doc), {}, credentials);
    return this.submission(res);
  }

  /** Step 3: exchange the compliance request ID for a production CSID. */
  async requestProductionCsid(complianceCredentials: CsidCredentials, complianceRequestId: string): Promise<CsidResponse> {
    const res = await this.request('POST', '/production/csids', { compliance_request_id: complianceRequestId }, {}, complianceCredentials);
    return this.csid(res);
  }

  /**
   * Renew a production CSID. If ZATCA answers NOT_COMPLIANT (HTTP 428 or 200), the
   * returned token is a compliance certificate: run compliance checks, then call
   * requestProductionCsid again.
   */
  async renewProductionCsid(currentCredentials: CsidCredentials, csrApiValue: string, otp: string): Promise<CsidResponse> {
    const res = await this.request('PATCH', '/production/csids', { csr: csrApiValue }, { OTP: otp }, currentCredentials, [428]);
    return this.csid(res);
  }

  /** Report a signed simplified (B2C) document within 24 hours of issue. */
  async reportInvoice(credentials: CsidCredentials, doc: SubmittableDocument): Promise<SubmissionResult> {
    const res = await this.request('POST', '/invoices/reporting/single', this.invoiceBody(doc), { 'Clearance-Status': '0' }, credentials, [409]);
    return this.submission(res);
  }

  /** Clear a standard (B2B) document before sharing it; give the buyer `clearedInvoiceXml`. */
  async clearInvoice(credentials: CsidCredentials, doc: SubmittableDocument): Promise<SubmissionResult> {
    const res = await this.request('POST', '/invoices/clearance/single', this.invoiceBody(doc), { 'Clearance-Status': '1' }, credentials, [208, 303]);
    if (res.status === 303) {
      throw new FatooraApiError('Clearance is deactivated for this taxpayer: submit standard invoices with reportInvoice() instead.', 303, [], res.body);
    }
    return this.submission(res);
  }

  // ---------- internals ----------

  private invoiceBody(doc: SubmittableDocument) {
    return { invoiceHash: doc.invoiceHash, uuid: doc.uuid, invoice: toApiInvoicePayload(doc.xml) };
  }

  private async request(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    extraHeaders: Record<string, string>,
    credentials?: CsidCredentials,
    passStatuses: number[] = [],
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      'Accept-Version': 'V2',
      'Accept-Language': this.language,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (credentials) {
      headers.Authorization = `Basic ${bytesToBase64(utf8Encode(`${credentials.binarySecurityToken}:${credentials.secret}`))}`;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const textBody = await response.text();
        let parsed: unknown = textBody;
        try {
          parsed = textBody ? JSON.parse(textBody) : undefined;
        } catch {
          // plain-text bodies (e.g. 406) stay as strings
        }
        if (response.status >= 500 && attempt < this.retries) {
          lastError = new FatooraApiError(`ZATCA server error ${response.status}`, response.status, normaliseMessages(parsed), parsed);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const ok = (response.status >= 200 && response.status < 300) || passStatuses.includes(response.status);
        // 400 on invoice endpoints carries validation results; let the caller see them.
        if (ok || (response.status === 400 && isInvoicePath(path))) return { status: response.status, body: parsed };
        throw apiError(response.status, parsed);
      } catch (e) {
        if (e instanceof FatooraApiError) throw e;
        lastError = e;
        if (attempt < this.retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new FatooraApiError(`Could not reach ZATCA (${(lastError as Error)?.message ?? 'unknown error'})`, 0, [], lastError);
  }

  private csid(res: { status: number; body: unknown }): CsidResponse {
    const b = (res.body ?? {}) as Record<string, unknown>;
    if (typeof b.binarySecurityToken !== 'string' || typeof b.secret !== 'string') {
      throw apiError(res.status, res.body);
    }
    return {
      requestID: String(b.requestID ?? ''),
      dispositionMessage: String(b.dispositionMessage ?? ''),
      binarySecurityToken: b.binarySecurityToken,
      secret: b.secret,
      ...(typeof b.tokenType === 'string' && { tokenType: b.tokenType }),
    };
  }

  private submission(res: { status: number; body: unknown }): SubmissionResult {
    const b = (typeof res.body === 'object' && res.body !== null ? res.body : {}) as Record<string, unknown>;
    const vr = (b.validationResults ?? {}) as Record<string, unknown>;
    const errors = [...normaliseMessages(vr.errorMessages), ...normaliseMessages(vr.erroMessages), ...normaliseMessages(b.errors)];
    const warnings = [...normaliseMessages(vr.warningMessages), ...normaliseMessages(b.warnings)];
    const info = normaliseMessages(vr.infoMessages);
    const reportingStatus = typeof b.reportingStatus === 'string' ? b.reportingStatus : undefined;
    const clearanceStatus = typeof b.clearanceStatus === 'string' ? b.clearanceStatus : undefined;
    const duplicate = res.status === 409 || res.status === 208;
    const accepted =
      duplicate || reportingStatus === 'REPORTED' || clearanceStatus === 'CLEARED' || (res.status >= 200 && res.status < 300 && errors.length === 0);
    const rawStatus = typeof vr.status === 'string' ? vr.status.toUpperCase() : undefined;
    const status = rawStatus === 'PASS' || rawStatus === 'WARNING' || rawStatus === 'ERROR' ? rawStatus : errors.length ? 'ERROR' : 'UNKNOWN';
    return {
      httpStatus: res.status,
      status,
      accepted: accepted && errors.length === 0,
      duplicate,
      ...(reportingStatus && { reportingStatus }),
      ...(clearanceStatus && { clearanceStatus }),
      ...(typeof b.clearedInvoice === 'string' && { clearedInvoiceXml: fromApiInvoicePayload(b.clearedInvoice) }),
      info,
      warnings,
      errors,
      raw: res.body,
    };
  }
}

function isInvoicePath(path: string): boolean {
  return path.startsWith('/invoices') || path === '/compliance/invoices';
}

function normaliseMessages(value: unknown): ValidationMessage[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      ...(typeof m.type === 'string' && { type: m.type }),
      code: String(m.code ?? ''),
      ...(typeof m.category === 'string' && { category: m.category }),
      message: String(m.message ?? ''),
      ...(typeof m.status === 'string' && { status: m.status }),
    }));
}

function apiError(status: number, body: unknown): FatooraApiError {
  const messages = normaliseMessages((body as Record<string, unknown> | undefined)?.errors ?? body);
  const hint =
    status === 401
      ? ' (check the binarySecurityToken/secret: use the token exactly as ZATCA returned it)'
      : status === 406
        ? ' (Accept-Version header must be V2)'
        : '';
  const detail = messages.map((m) => `${m.code}: ${m.message}`).join('; ') || (typeof body === 'string' ? body : JSON.stringify(body));
  return new FatooraApiError(`ZATCA API error ${status}${hint}: ${detail}`, status, messages, body);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
