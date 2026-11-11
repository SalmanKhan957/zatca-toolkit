import { der } from './asn1.js';
import { bytesToBase64, derToPem, utf8Encode } from './encoding.js';
import { publicKeyFromPrivate, publicKeyToSpki, signEcdsa } from './keys.js';

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';

/** Certificate template name ZATCA expects per environment (extension 1.3.6.1.4.1.311.20.2). */
export const CERTIFICATE_TEMPLATE: Record<ZatcaEnvironment, string> = {
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

export interface CsrInput {
  /** CN: unique name of this EGS unit, e.g. "TST-886431145-399999999900003" */
  commonName: string;
  /** EGS serial "1-<solution>|2-<model/version>|3-<serial>"; see egsSerialNumber() */
  serialNumber: string;
  /** 15-digit VAT (or VAT group) number */
  vatNumber: string;
  /** OU: branch name; for VAT groups, the 10-digit TIN of the member */
  organizationUnit: string;
  /** O: taxpayer name (Arabic allowed) */
  organizationName: string;
  /** C: ISO country code, default "SA" */
  country?: string;
  /**
   * 4 digits "TSCZ": T=standard (B2B), S=simplified (B2C), C/Z reserved (0).
   * "1100" = both, "1000" = B2B only, "0100" = B2C only.
   */
  invoiceType: string;
  /** registeredAddress: branch address, e.g. the national short address "RRRD2929" */
  location: string;
  /** businessCategory: industry, e.g. "Supply activities" */
  industry: string;
  environment: ZatcaEnvironment;
  /** Override the template name (rarely needed) */
  templateName?: string;
}

export interface GeneratedCsr {
  pem: string;
  der: Uint8Array;
  /** The value to send as `csr` in POST /compliance: base64 of the PEM text, armour included */
  apiValue: string;
}

const OID = {
  C: '2.5.4.6',
  OU: '2.5.4.11',
  O: '2.5.4.10',
  CN: '2.5.4.3',
  SN: '2.5.4.4',
  UID: '0.9.2342.19200300.100.1.1',
  title: '2.5.4.12',
  registeredAddress: '2.5.4.26',
  businessCategory: '2.5.4.15',
  extensionRequest: '1.2.840.113549.1.9.14',
  certificateTemplateName: '1.3.6.1.4.1.311.20.2',
  subjectAltName: '2.5.29.17',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

const rdn = (oid: string, value: Uint8Array) => der.set(der.sequence(der.oid(oid), value));

/** Build the EGS serial number string "1-…|2-…|3-…". */
export function egsSerialNumber(solutionName: string, modelOrVersion: string, serial: string): string {
  return `1-${solutionName}|2-${modelOrVersion}|3-${serial}`;
}

export function validateCsrInput(input: CsrInput): string[] {
  const problems: string[] = [];
  if (!/^3\d{13}3$/.test(input.vatNumber)) problems.push('vatNumber must be 15 digits starting and ending with 3.');
  if (!/^[01]{2}00$/.test(input.invoiceType) || input.invoiceType === '0000') {
    problems.push('invoiceType must be "1100" (both), "1000" (standard/B2B only) or "0100" (simplified/B2C only).');
  }
  if (!/^1-[^|]+\|2-[^|]+\|3-[^|]+$/.test(input.serialNumber)) problems.push('serialNumber must look like "1-<solution>|2-<model>|3-<serial>".');
  for (const k of ['commonName', 'organizationUnit', 'organizationName', 'location', 'industry'] as const) {
    if (!input[k] || !input[k].trim()) problems.push(`${k} is required.`);
  }
  if (input.vatNumber[10] === '1' && !/^\d{10}$/.test(input.organizationUnit)) {
    problems.push('This is a VAT group number (11th digit is 1): organizationUnit must be the 10-digit TIN of the member being onboarded.');
  }
  return problems;
}

/**
 * Generate a PKCS#10 CSR that matches ZATCA's official sample byte-for-byte in structure:
 * subject C/OU/O/CN, the certificate template extension (UTF8String), and a SAN
 * directoryName carrying SN, UID (VAT number), title (invoice type), registeredAddress
 * and businessCategory. Signed with ECDSA secp256k1 / SHA-256.
 */
export function generateCsr(input: CsrInput, privateKey: Uint8Array): GeneratedCsr {
  const problems = validateCsrInput(input);
  if (problems.length > 0) throw new Error(`Invalid CSR input:\n- ${problems.join('\n- ')}`);

  const subject = der.sequence(
    rdn(OID.C, der.printable(input.country ?? 'SA')),
    rdn(OID.OU, der.utf8(input.organizationUnit)),
    rdn(OID.O, der.utf8(input.organizationName)),
    rdn(OID.CN, der.utf8(input.commonName)),
  );

  const directoryName = der.sequence(
    rdn(OID.SN, der.utf8(input.serialNumber)),
    rdn(OID.UID, der.utf8(input.vatNumber)),
    rdn(OID.title, der.utf8(input.invoiceType)),
    rdn(OID.registeredAddress, der.utf8(input.location)),
    rdn(OID.businessCategory, der.utf8(input.industry)),
  );
  const subjectAltName = der.sequence(der.explicit(4, directoryName)); // GeneralNames { [4] directoryName }

  const extensions = der.sequence(
    der.sequence(der.oid(OID.certificateTemplateName), der.octetString(der.utf8(input.templateName ?? CERTIFICATE_TEMPLATE[input.environment]))),
    der.sequence(der.oid(OID.subjectAltName), der.octetString(subjectAltName)),
  );
  const attributes = der.implicitConstructed(0, der.sequence(der.oid(OID.extensionRequest), der.set(extensions)));

  const spki = publicKeyToSpki(publicKeyFromPrivate(privateKey));
  const info = der.sequence(der.integer(0), subject, spki, attributes);
  const signature = signEcdsa(info, privateKey);
  const csrDer = der.sequence(info, der.sequence(der.oid(OID.ecdsaWithSha256)), der.bitString(signature));

  const pem = derToPem(csrDer, 'CERTIFICATE REQUEST');
  return { pem, der: csrDer, apiValue: bytesToBase64(utf8Encode(pem)) };
}
