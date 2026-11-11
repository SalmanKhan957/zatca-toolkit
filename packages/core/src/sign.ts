import { NS, child, parseXml, path, text } from './dom.js';
import { base64ToBytes, bytesToBase64 } from './encoding.js';
import { computeInvoiceHash, invoiceHashBytes } from './hash.js';
import { parsePrivateKey, publicKeyFromPrivate, signEcdsa } from './keys.js';
import { Decimal } from './money.js';
import { encodeQr } from './qr.js';
import { signedPropertiesDigest } from './signed-properties.js';
import { type ParsedCertificate, formatName, parseCertificate, zatcaCertDigest } from './x509.js';

export interface SigningCredentials {
  /** secp256k1 private key: PEM, bare base64 (SEC1/PKCS#8) or 64-char hex */
  privateKey: string | Uint8Array;
  /**
   * The CSID certificate: PEM, bare base64 DER, or the `binarySecurityToken` exactly as
   * returned by ZATCA's /compliance or /production/csids APIs.
   */
  certificate: string;
}

export interface SignOptions {
  /** Defaults to now. Written as UTC "YYYY-MM-DDTHH:mm:ss" (the SDK format, no zone suffix). */
  signingTime?: Date;
}

export interface SignedInvoice {
  /** Final signed XML, ready to submit (base64 it for the API) */
  xml: string;
  /** Invoice hash (base64, 44 chars). Use it as the next document's previousInvoiceHash. */
  invoiceHash: string;
  /** Base64 DER ECDSA signature */
  signatureValue: string;
  /** Base64 QR payload to render as the QR image */
  qr: string;
  uuid: string;
  signingTime: string;
}

/** UTC time as YYYY-MM-DDTHH:mm:ss */
export function formatSigningTime(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/**
 * The <xades:SignedProperties> block, laid out exactly like ZATCA's SDK output. The first
 * line carries no indentation (it is prefixed when embedded); following lines keep their
 * absolute indentation, which is part of the digest.
 */
function signedPropertiesText(signingTime: string, certDigest: string, issuer: string, serial: string): string {
  const i = (n: number) => ' '.repeat(n);
  return [
    `<xades:SignedProperties Id="xadesSignedProperties">`,
    `${i(36)}<xades:SignedSignatureProperties>`,
    `${i(40)}<xades:SigningTime>${signingTime}</xades:SigningTime>`,
    `${i(40)}<xades:SigningCertificate>`,
    `${i(44)}<xades:Cert>`,
    `${i(48)}<xades:CertDigest>`,
    `${i(52)}<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${i(52)}<ds:DigestValue>${certDigest}</ds:DigestValue>`,
    `${i(48)}</xades:CertDigest>`,
    `${i(48)}<xades:IssuerSerial>`,
    `${i(52)}<ds:X509IssuerName>${escapeXml(issuer)}</ds:X509IssuerName>`,
    `${i(52)}<ds:X509SerialNumber>${serial}</ds:X509SerialNumber>`,
    `${i(48)}</xades:IssuerSerial>`,
    `${i(44)}</xades:Cert>`,
    `${i(40)}</xades:SigningCertificate>`,
    `${i(36)}</xades:SignedSignatureProperties>`,
    `${i(32)}</xades:SignedProperties>`,
  ].join('\n');
}

function ublExtensionsBlock(p: {
  invoiceHash: string;
  signedPropertiesDigest: string;
  signatureValue: string;
  certificateBase64: string;
  signedProperties: string;
}): string {
  const i = (n: number) => ' '.repeat(n);
  return [
    `<ext:UBLExtensions>`,
    `${i(4)}<ext:UBLExtension>`,
    `${i(8)}<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>`,
    `${i(8)}<ext:ExtensionContent>`,
    `${i(12)}<sig:UBLDocumentSignatures xmlns:sig="${NS.sig}" xmlns:sac="${NS.sac}" xmlns:sbc="${NS.sbc}">`,
    `${i(16)}<sac:SignatureInformation>`,
    `${i(20)}<cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>`,
    `${i(20)}<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>`,
    `${i(20)}<ds:Signature xmlns:ds="${NS.ds}" Id="signature">`,
    `${i(24)}<ds:SignedInfo>`,
    `${i(28)}<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>`,
    `${i(28)}<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>`,
    `${i(28)}<ds:Reference Id="invoiceSignedData" URI="">`,
    `${i(32)}<ds:Transforms>`,
    `${i(36)}<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">`,
    `${i(40)}<ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>`,
    `${i(36)}</ds:Transform>`,
    `${i(36)}<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">`,
    `${i(40)}<ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>`,
    `${i(36)}</ds:Transform>`,
    `${i(36)}<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">`,
    `${i(40)}<ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>`,
    `${i(36)}</ds:Transform>`,
    `${i(36)}<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>`,
    `${i(32)}</ds:Transforms>`,
    `${i(32)}<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${i(32)}<ds:DigestValue>${p.invoiceHash}</ds:DigestValue>`,
    `${i(28)}</ds:Reference>`,
    `${i(28)}<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">`,
    `${i(32)}<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${i(32)}<ds:DigestValue>${p.signedPropertiesDigest}</ds:DigestValue>`,
    `${i(28)}</ds:Reference>`,
    `${i(24)}</ds:SignedInfo>`,
    `${i(24)}<ds:SignatureValue>${p.signatureValue}</ds:SignatureValue>`,
    `${i(24)}<ds:KeyInfo>`,
    `${i(28)}<ds:X509Data>`,
    `${i(32)}<ds:X509Certificate>${p.certificateBase64}</ds:X509Certificate>`,
    `${i(28)}</ds:X509Data>`,
    `${i(24)}</ds:KeyInfo>`,
    `${i(24)}<ds:Object>`,
    `${i(28)}<xades:QualifyingProperties xmlns:xades="${NS.xades}" Target="signature">`,
    `${i(32)}${p.signedProperties}`,
    `${i(28)}</xades:QualifyingProperties>`,
    `${i(24)}</ds:Object>`,
    `${i(20)}</ds:Signature>`,
    `${i(16)}</sac:SignatureInformation>`,
    `${i(12)}</sig:UBLDocumentSignatures>`,
    `${i(8)}</ext:ExtensionContent>`,
    `${i(4)}</ext:UBLExtension>`,
    `</ext:UBLExtensions>`,
  ].join('\n');
}

function qrAndSignatureBlock(qr: string): string {
  return [
    `<cac:AdditionalDocumentReference>`,
    `        <cbc:ID>QR</cbc:ID>`,
    `        <cac:Attachment>`,
    `            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject>`,
    `        </cac:Attachment>`,
    `    </cac:AdditionalDocumentReference><cac:Signature>`,
    `        <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>`,
    `        <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>`,
    `    </cac:Signature>`,
  ].join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class SigningError extends Error {}

/**
 * Sign an unsigned ZATCA invoice: computes the invoice hash, the ECDSA signature, the
 * XAdES properties and the QR code, then inserts them without touching any byte that
 * the hash covers. Works for simplified (B2C) documents, which must be signed, and for
 * standard (B2B) documents, which may be signed before clearance.
 */
export function signInvoice(unsignedXml: string, credentials: SigningCredentials, options: SignOptions = {}): SignedInvoice {
  const xml = unsignedXml.replace(/\r\n?/g, '\n');
  const doc = parseXml(xml);
  const root = doc.documentElement as Element;

  if (root.namespaceURI !== NS.invoice || root.tagName !== 'Invoice') {
    throw new SigningError('Root element must be <Invoice> in the UBL Invoice-2 default namespace.');
  }
  for (const [prefix, uri] of [['cac', NS.cac], ['cbc', NS.cbc], ['ext', NS.ext]] as const) {
    if (root.getAttribute(`xmlns:${prefix}`) !== uri) {
      throw new SigningError(`The <Invoice> element must declare xmlns:${prefix}="${uri}" (the signature block uses that prefix, and root namespaces are part of the hash).`);
    }
  }
  if (child(root, NS.ext, 'UBLExtensions') || child(root, NS.cac, 'Signature')) {
    throw new SigningError('This document is already signed. Pass the unsigned XML.');
  }
  const hasQr = [...(root.getElementsByTagNameNS(NS.cac, 'AdditionalDocumentReference') as unknown as Element[])].some(
    (r) => text(child(r, NS.cbc, 'ID'))?.trim() === 'QR',
  );
  if (hasQr) throw new SigningError('This document already has a QR AdditionalDocumentReference. Pass the unsigned XML.');

  // Key material
  const privateKey = typeof credentials.privateKey === 'string' ? parsePrivateKey(credentials.privateKey) : credentials.privateKey;
  let cert: ParsedCertificate;
  try {
    cert = parseCertificate(credentials.certificate);
  } catch (e) {
    throw new SigningError(`Could not read the certificate: ${(e as Error).message}`);
  }
  const pub = publicKeyFromPrivate(privateKey);
  if (bytesToBase64(pub) !== bytesToBase64(cert.publicKeyPoint)) {
    throw new SigningError('The private key does not match the certificate. Use the key that generated the CSR this certificate was issued for.');
  }

  // 1. Hash and sign
  const hashBytes = invoiceHashBytes(doc);
  const invoiceHash = bytesToBase64(hashBytes);
  const signatureValue = bytesToBase64(signEcdsa(hashBytes, privateKey));

  // 2. XAdES signed properties
  const signingTime = formatSigningTime(options.signingTime ?? new Date());
  const sp = signedPropertiesText(signingTime, zatcaCertDigest(cert), formatName(cert.issuer), cert.serialNumber.toString(10));
  const spDigest = signedPropertiesDigest(sp);

  // 3. QR (values copied verbatim from the XML text, as ZATCA's validator compares them)
  const supplier = path(root, [NS.cac, 'AccountingSupplierParty'], [NS.cac, 'Party']);
  const monetary = child(root, NS.cac, 'LegalMonetaryTotal');
  const prepaid = text(child(monetary!, NS.cbc, 'PrepaidAmount'));
  const rounding = text(child(monetary!, NS.cbc, 'PayableRoundingAmount'));
  const usePayable = [prepaid, rounding].some((v) => v !== undefined && !Decimal.from(v.trim()).isZero());
  const totalText = text(child(monetary!, NS.cbc, usePayable ? 'PayableAmount' : 'TaxInclusiveAmount'));
  const isSimplified = (child(root, NS.cbc, 'InvoiceTypeCode')?.getAttribute('name') ?? '').startsWith('02');

  const qrFields = {
    sellerName: text(path(supplier, [NS.cac, 'PartyLegalEntity'], [NS.cbc, 'RegistrationName'])),
    vatNumber: text(path(supplier, [NS.cac, 'PartyTaxScheme'], [NS.cbc, 'CompanyID'])),
    issueDate: text(child(root, NS.cbc, 'IssueDate')),
    issueTime: text(child(root, NS.cbc, 'IssueTime')),
    total: totalText,
    vat: text(path(root, [NS.cac, 'TaxTotal'], [NS.cbc, 'TaxAmount'])),
  };
  for (const [k, v] of Object.entries(qrFields)) {
    if (v === undefined || v.trim() === '') throw new SigningError(`Cannot build the QR code: the invoice has no value for ${k}.`);
  }
  const qr = encodeQr({
    sellerName: qrFields.sellerName!,
    vatNumber: qrFields.vatNumber!,
    timestamp: `${qrFields.issueDate}T${qrFields.issueTime}`,
    totalWithVat: qrFields.total!,
    vatTotal: qrFields.vat!,
    invoiceHash,
    signature: signatureValue,
    publicKey: cert.publicKeySpki,
    ...(isSimplified && { certificateSignature: cert.signatureValue }),
  });

  // 4. Insert the blocks outside the hashed region, adding no whitespace there.
  const rootStart = /<Invoice\b[^>]*>/.exec(xml);
  const supplierAt = xml.indexOf('<cac:AccountingSupplierParty');
  if (!rootStart || supplierAt < 0) throw new SigningError('Could not locate <Invoice> or <cac:AccountingSupplierParty> in the XML text.');
  const afterRoot = rootStart.index + rootStart[0].length;
  const signedXml =
    xml.slice(0, afterRoot) +
    ublExtensionsBlock({ invoiceHash, signedPropertiesDigest: spDigest, signatureValue, certificateBase64: cert.base64, signedProperties: sp }) +
    xml.slice(afterRoot, supplierAt) +
    qrAndSignatureBlock(qr) +
    xml.slice(supplierAt);

  // 5. Safety net: the signed document must hash to exactly the value we signed.
  if (computeInvoiceHash(signedXml) !== invoiceHash) {
    throw new SigningError('Internal error: inserting the signature changed the invoice hash. Please report this with the input XML.');
  }

  return {
    xml: signedXml,
    invoiceHash,
    signatureValue,
    qr,
    uuid: text(child(root, NS.cbc, 'UUID')) ?? '',
    signingTime,
  };
}

/** Convenience: the base64 payload the Fatoora API expects in the `invoice` field. */
export function toApiInvoicePayload(xml: string): string {
  return bytesToBase64(new TextEncoder().encode(xml));
}

/** Decode a base64 invoice returned by the API (e.g. `clearedInvoice`). */
export function fromApiInvoicePayload(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}
