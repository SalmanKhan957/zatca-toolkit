/**
 * zatca-toolkit: generate, sign, validate and submit Saudi ZATCA (Fatoora) Phase 2
 * e-invoices in TypeScript. Pure JS (no OpenSSL, no Java); runs in Node, browsers
 * and edge workers. Not affiliated with or endorsed by ZATCA.
 */
import type { ComputedTotals } from './calc.js';
import { type SignOptions, type SignedInvoice, type SigningCredentials, signInvoice } from './sign.js';
import type { InvoiceInput } from './types.js';
import { buildInvoiceXml } from './xml-builder.js';

export type * from './types.js';

// High-level
export { buildInvoiceXml, transactionCode, type BuiltInvoice } from './xml-builder.js';
export { signInvoice, formatSigningTime, toApiInvoicePayload, fromApiInvoicePayload, SigningError } from './sign.js';
export type { SignedInvoice, SigningCredentials, SignOptions } from './sign.js';
export { validateInvoice, type ValidationReport, type Finding, type ValidateOptions } from './validate.js';
export { explainCode, RULES, type CatalogEntry, type Severity } from './catalog.js';

// Onboarding and API
export { generateCsr, egsSerialNumber, validateCsrInput, CERTIFICATE_TEMPLATE } from './csr.js';
export type { CsrInput, GeneratedCsr, ZatcaEnvironment } from './csr.js';
export { FatooraClient, FatooraApiError, FATOORA_BASE_URLS, SANDBOX_OTP } from './api.js';
export type { CsidCredentials, CsidResponse, SubmissionResult, SubmittableDocument, ValidationMessage, FatooraClientOptions } from './api.js';

// Building blocks
export { computeTotals, resolveVat, type ComputedTotals, type ComputedLine, type VatSubtotal } from './calc.js';
export { computeInvoiceHash, invoiceHashBytes, canonicalInvoice, INITIAL_PREVIOUS_INVOICE_HASH } from './hash.js';
export { encodeQr, decodeQr, QR_MAX_BASE64_LENGTH, type QrFields, type DecodedQr, type DecodedQrTag } from './qr.js';
export { canonicalize } from './c14n.js';
export { signedPropertiesDigest, signedPropertiesHashInput } from './signed-properties.js';
export { generateKeyPair, parsePrivateKey, privateKeyToPem, publicKeyFromPrivate, publicKeyToSpki, signEcdsa, verifyEcdsa, type KeyPair } from './keys.js';
export { parseCertificate, formatName, zatcaCertDigest, type ParsedCertificate } from './x509.js';
export { createTestCertificate, type TestCertificateOptions } from './test-certificate.js';
export { Decimal } from './money.js';

export interface CreatedInvoice extends SignedInvoice {
  totals: ComputedTotals;
}

/** Build and sign in one call: the usual path for simplified (B2C) invoices. */
export function createSignedInvoice(input: InvoiceInput, credentials: SigningCredentials, options?: SignOptions): CreatedInvoice {
  const built = buildInvoiceXml(input);
  return { ...signInvoice(built.xml, credentials, options), totals: built.totals };
}
