import {
  type CreatedInvoice,
  type Finding,
  INITIAL_PREVIOUS_INVOICE_HASH,
  type InvoiceInput,
  type ValidationReport,
  type VatCategory,
  buildInvoiceXml,
  createTestCertificate,
  decodeQr,
  generateKeyPair,
  signInvoice,
  validateInvoice,
} from 'zatca-toolkit';

declare const qrcode: (typeNumber: number, level: 'L' | 'M' | 'Q' | 'H') => {
  addData(data: string, mode?: string): void;
  make(): void;
  createSvgTag(opts: { cellSize?: number; margin?: number; scalable?: boolean }): string;
};
declare const jsQR: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

// ---------- tiny DOM helper ----------
type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== false && kid !== null && kid !== undefined) el.append(kid);
  return el;
}
/** replaceChildren, skipping false/null/undefined placeholders */
function fill(el: HTMLElement, ...kids: Child[]): void {
  el.replaceChildren(...kids.filter((k): k is Node | string => k !== false && k !== null && k !== undefined));
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();

function copyButton(getText: () => string, label = 'Copy'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'btn icon copy' }, label);
  b.addEventListener('click', () => {
    const text = getText();
    const done = () => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = label), 1500);
    };
    navigator.clipboard?.writeText(text).then(done, () => selectFallback(b, text));
  });
  return b;
}
function selectFallback(anchor: HTMLElement, text: string) {
  const pre = anchor.parentElement?.querySelector('pre');
  if (pre) {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    anchor.textContent = 'Press Ctrl+C';
  } else {
    void text;
  }
}

function qrSvg(payload: string): HTMLElement {
  const box = h('div', { class: 'qr-img', role: 'img', 'aria-label': 'QR code for this invoice' });
  if (typeof qrcode === 'function') {
    const q = qrcode(0, 'M');
    q.addData(payload, 'Byte');
    q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  } else {
    box.append(h('span', { class: 'hint' }, 'QR library did not load'));
  }
  return box;
}

const fmt = (s: string) => Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- session signing material (throwaway, browser-only) ----------
const { privateKey } = generateKeyPair();
const certificate = createTestCertificate(privateKey, { commonName: 'PLAYGROUND-TEST-ONLY', organization: 'zatca-toolkit playground' });
let counter = 0;
let previousInvoiceHash = INITIAL_PREVIOUS_INVOICE_HASH;
let lastInvoice: CreatedInvoice | undefined;

// ---------- tabs (hash-routed) ----------
const TABS = ['create', 'validate', 'qr'] as const;
type Tab = (typeof TABS)[number];
function showTab(tab: Tab) {
  for (const t of TABS) {
    $(t).hidden = t !== tab;
    $(`tab-btn-${t}`).setAttribute('aria-selected', String(t === tab));
  }
}
for (const btn of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab as Tab;
    showTab(tab);
    try {
      history.replaceState(null, '', `#${tab}`);
    } catch {
      location.hash = tab;
    }
  });
}
const fromHash = () => {
  const t = location.hash.slice(1) as Tab;
  showTab(TABS.includes(t) ? t : 'create');
};
window.addEventListener('hashchange', fromHash);

// ---------- create: lines editor ----------
interface LineState {
  name: string;
  quantity: string;
  unitPrice: string;
  category: VatCategory;
}
const lines: LineState[] = [
  { name: 'تطوير واجهة برمجية | API integration (hours)', quantity: '12', unitPrice: '350.00', category: 'S' },
  { name: 'استضافة سحابية | Cloud hosting, 1 month', quantity: '1', unitPrice: '499.99', category: 'S' },
];

function renderLines() {
  const box = $('lines');
  box.replaceChildren(
    ...lines.map((l, i) => {
      const id = (f: string) => `line-${i}-${f}`;
      const input = (field: 'name' | 'quantity' | 'unitPrice', attrs: Record<string, string>) => {
        const el = h('input', { id: id(field), value: l[field], ...attrs });
        el.addEventListener('input', () => (l[field] = el.value));
        return el;
      };
      const cat = h('select', { id: id('vat') }, ...(['S', 'Z', 'E', 'O'] as const).map((c) =>
        h('option', { value: c, selected: c === l.category }, { S: 'S · 15%', Z: 'Z · zero-rated', E: 'E · exempt', O: 'O · out of scope' }[c]),
      ));
      cat.addEventListener('change', () => (l.category = cat.value as VatCategory));
      const remove = h('button', { type: 'button', class: 'btn icon', 'aria-label': `Remove line ${i + 1}` }, '✕');
      remove.disabled = lines.length === 1;
      remove.addEventListener('click', () => {
        lines.splice(i, 1);
        renderLines();
      });
      return h(
        'div',
        { class: 'line-row' },
        h('label', { class: 'desc' }, `Line ${i + 1} description`, input('name', {})),
        h('label', {}, 'Qty', input('quantity', { inputmode: 'decimal', class: 'mono' })),
        h('label', {}, 'Unit price (SAR)', input('unitPrice', { inputmode: 'decimal', class: 'mono' })),
        h('label', {}, 'VAT', cat),
        remove,
      );
    }),
  );
}
$('add-line').addEventListener('click', () => {
  lines.push({ name: 'Support plan', quantity: '1', unitPrice: '100.00', category: 'S' });
  renderLines();
});

const syncVisibility = () => {
  $('buyer-fields').hidden = val('f-kind') !== 'standard';
  $('note-fields').hidden = val('f-type') === 'invoice';
};
$('f-kind').addEventListener('change', syncVisibility);
$('f-type').addEventListener('change', syncVisibility);

const EXEMPTIONS: Record<Exclude<VatCategory, 'S'>, [string, string]> = {
  Z: ['VATEX-SA-33', 'Export of services | تصدير الخدمات'],
  E: ['VATEX-SA-29', 'Financial services | الخدمات المالية'],
  O: ['VATEX-SA-OOS', 'Out of scope | خارج نطاق الضريبة'],
};

function readInput(): InvoiceInput {
  const ksa = new Date(Date.now() + 3 * 3600_000 - 60_000).toISOString();
  const kind = val('f-kind') as InvoiceInput['kind'];
  const type = val('f-type') as NonNullable<InvoiceInput['type']>;
  return {
    kind,
    type,
    number: val('f-number'),
    issueDate: ksa.slice(0, 10),
    issueTime: ksa.slice(11, 19),
    counter: counter + 1,
    previousInvoiceHash,
    paymentMeansCode: '10',
    seller: {
      name: val('f-seller-name'),
      vatNumber: val('f-seller-vat'),
      identification: { scheme: 'CRN', value: val('f-seller-crn') },
      address: { street: val('f-street'), buildingNumber: val('f-building'), district: val('f-district'), city: val('f-city'), postalCode: val('f-postal'), country: 'SA' },
    },
    ...(kind === 'standard' && {
      supplyDate: ksa.slice(0, 10),
      buyer: {
        name: val('f-buyer-name'),
        vatNumber: val('f-buyer-vat'),
        address: { street: val('f-b-street'), buildingNumber: val('f-b-building'), district: val('f-b-district'), city: val('f-b-city'), postalCode: val('f-b-postal'), country: 'SA' },
      },
    }),
    ...(type !== 'invoice' && { billingReference: val('f-billing'), reason: val('f-reason') }),
    lines: lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vat: l.category === 'S' ? { category: 'S' } : { category: l.category, exemptionReasonCode: EXEMPTIONS[l.category][0], exemptionReason: EXEMPTIONS[l.category][1] },
    })),
  };
}

function buildAndSign() {
  const out = $('create-result');
  try {
    const input = readInput();
    const built = buildInvoiceXml(input);
    const signed = signInvoice(built.xml, { privateKey, certificate });
    counter = input.counter;
    previousInvoiceHash = signed.invoiceHash;
    lastInvoice = { ...signed, totals: built.totals };
    renderCreateResult(lastInvoice, input, validateInvoice(signed.xml));
    $('chain-hint').textContent = `Next invoice will be ICV ${counter + 1}, chained to this one's hash.`;
    $<HTMLTextAreaElement>('qr-input').value = signed.qr;
    runQr();
  } catch (e) {
    out.replaceChildren(h('h2', {}, 'Could not build the invoice'), h('div', { class: 'error-box' }, (e as Error).message));
  }
}

function renderCreateResult(inv: CreatedInvoice, input: InvoiceInput, report: ValidationReport) {
  const t = inv.totals;
  const vatLabel = t.subtotals.length === 1 && t.subtotals[0]!.vat.category === 'S' ? 'VAT 15%' : 'VAT';
  const pill = report.valid
    ? report.warnings.length
      ? h('span', { class: 'pill warn' }, `Valid with ${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''}`)
      : h('span', { class: 'pill ok' }, '✓ Passes all checks')
    : h('span', { class: 'pill bad' }, `${report.errors.length} error${report.errors.length > 1 ? 's' : ''}`);
  const openInValidator = h('button', { type: 'button', class: 'btn' }, 'Open in validator');
  openInValidator.addEventListener('click', () => {
    $<HTMLTextAreaElement>('xml-input').value = inv.xml;
    runValidate();
    location.hash = 'validate';
  });

  $('create-result').replaceChildren(
    h('div', { class: 'status' }, h('h2', {}, `${input.kind === 'standard' ? 'Standard' : 'Simplified'} ${input.type === 'invoice' ? 'tax invoice' : input.type === 'credit-note' ? 'credit note' : 'debit note'} ${input.number}`), pill),
    h(
      'table',
      { class: 'totals' },
      h('tbody', {},
        h('tr', {}, h('td', {}, 'Total excluding VAT'), h('td', {}, fmt(t.taxExclusiveAmount.toFixed()), ' ', h('span', { class: 'sar' }, 'SAR'))),
        h('tr', {}, h('td', {}, vatLabel), h('td', {}, fmt(t.taxAmount.toFixed()), ' ', h('span', { class: 'sar' }, 'SAR'))),
        h('tr', { class: 'grand' }, h('td', {}, 'Total with VAT'), h('td', {}, fmt(t.taxInclusiveAmount.toFixed()), ' ', h('span', { class: 'sar' }, 'SAR'))),
      ),
    ),
    h(
      'div',
      { class: 'qr-block' },
      qrSvg(inv.qr),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Counter (ICV)'), h('dd', {}, String(input.counter)),
        h('dt', {}, 'Invoice hash'), h('dd', {}, inv.invoiceHash),
        h('dt', {}, 'Previous hash'), h('dd', {}, String(input.previousInvoiceHash).slice(0, 24) + '…'),
        h('dt', {}, 'UUID'), h('dd', {}, inv.uuid),
        h('dt', {}, 'Signed at (UTC)'), h('dd', {}, inv.signingTime),
      ),
    ),
    h('div', { class: 'row' }, openInValidator, h('span', { class: 'hint' }, `QR carries ${input.kind === 'simplified' ? '9' : '8'} tags; ${input.kind === 'simplified' ? 'report within 24 hours' : 'clear with ZATCA before sharing'}.`)),
    h('div', { class: 'code' }, h('pre', {}, inv.xml), copyButton(() => inv.xml, 'Copy XML')),
  );
}

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  buildAndSign();
});

// ---------- validate ----------
function findingEl(f: Finding): HTMLElement {
  return h(
    'div',
    { class: `finding ${f.severity}` },
    h('div', { class: 'head' }, h('span', { class: 'chip' }, f.code), h('span', { class: 'msg' }, f.message)),
    h('p', { class: 'ar', lang: 'ar', dir: 'rtl' }, f.messageAr),
    f.detail ? h('p', { class: 'detail' }, f.detail) : null,
    f.fix ? h('p', { class: 'fix' }, h('b', {}, 'Fix: '), f.fix) : null,
  );
}

function renderReport(target: HTMLElement, r: ValidationReport) {
  const title = r.valid ? (r.warnings.length ? 'Accepted with warnings' : 'No problems found') : 'ZATCA would reject this document';
  const pill = r.valid
    ? h('span', { class: `pill ${r.warnings.length ? 'warn' : 'ok'}` }, r.warnings.length ? `${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}` : '✓ Pass')
    : h('span', { class: 'pill bad' }, `${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`);
  const facts = [r.kind ? `${r.kind} ${r.documentType ?? ''}` : 'unknown type', r.signed ? 'signed' : 'unsigned'].join(' · ');
  fill(
    target,
    h('div', { class: 'status' }, h('h2', {}, title), pill),
    h('p', { class: 'hint' }, facts),
    r.invoiceHash ? h('dl', { class: 'kv' }, h('dt', {}, 'Invoice hash'), h('dd', {}, r.invoiceHash)) : null,
    r.errors.length ? h('div', { class: 'findings' }, h('p', { class: 'eyebrow' }, 'Errors'), ...r.errors.map(findingEl)) : null,
    r.warnings.length ? h('div', { class: 'findings' }, h('p', { class: 'eyebrow' }, 'Warnings'), ...r.warnings.map(findingEl)) : null,
    r.signatureChecks.length
      ? h('div', {}, h('p', { class: 'eyebrow' }, 'Signature and QR checks'), h('ul', { class: 'checks' }, ...r.signatureChecks.map((c) => h('li', {}, h('span', { class: c.passed ? 'y' : 'n' }, c.passed ? '✓' : '✗'), c.check))))
      : null,
    h('p', { class: 'note' }, 'Checks the rules developers break most often, plus the cryptography. It does not replace ZATCA\'s official validator.'),
  );
}

let validateTimer: ReturnType<typeof setTimeout> | undefined;
function runValidate() {
  const xml = $<HTMLTextAreaElement>('xml-input').value;
  const out = $('validate-result');
  if (!xml.trim()) {
    out.replaceChildren(h('h2', {}, 'Nothing to check yet'), h('p', { class: 'hint' }, 'Paste an invoice, open a file, or load one of the examples.'));
    return;
  }
  renderReport(out, validateInvoice(xml));
}
$('xml-input').addEventListener('input', () => {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(runValidate, 250);
});
$('load-good').addEventListener('click', () => {
  if (!lastInvoice) buildAndSign();
  $<HTMLTextAreaElement>('xml-input').value = lastInvoice?.xml ?? '';
  runValidate();
});
$('load-bad').addEventListener('click', () => {
  if (!lastInvoice) buildAndSign();
  const xml = lastInvoice?.xml ?? '';
  // Change the first line's quantity after signing: the hash, signature and QR no longer match.
  const tampered = xml.replace(/(<cbc:InvoicedQuantity unitCode="PCE">)([^<]+)(<\/cbc:InvoicedQuantity>)/, (_m, a: string, q: string, b: string) => `${a}${Number(q) + 1}${b}`);
  $<HTMLTextAreaElement>('xml-input').value = tampered;
  runValidate();
});
$<HTMLInputElement>('xml-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  $<HTMLTextAreaElement>('xml-input').value = await file.text();
  runValidate();
});

// ---------- QR ----------
const TAG_NAMES: Record<number, string> = {
  1: 'Seller name',
  2: 'VAT number',
  3: 'Timestamp',
  4: 'Total with VAT',
  5: 'VAT total',
  6: 'Invoice hash',
  7: 'ECDSA signature',
  8: 'Public key (DER)',
  9: 'Certificate signature (DER)',
};
function runQr(payload?: string) {
  const text = (payload ?? $<HTMLTextAreaElement>('qr-input').value).trim();
  const out = $('qr-result');
  if (!text) {
    out.replaceChildren(h('h2', {}, 'Nothing to decode yet'), h('p', { class: 'hint' }, 'Paste a payload or open an image of a QR code.'));
    return;
  }
  try {
    const { tags, warnings } = decodeQr(text);
    const phase2 = tags.length >= 8;
    fill(
      out,
      h('div', { class: 'status' }, h('h2', {}, phase2 ? 'Phase 2 QR code' : 'Phase 1 QR code'), h('span', { class: `pill ${warnings.length ? 'bad' : phase2 ? 'ok' : 'warn'}` }, warnings.length ? 'ZATCA may reject' : phase2 ? `${tags.length} tags` : 'Not valid for Phase 2')),
      phase2 ? null : h('p', { class: 'hint' }, 'Only tags 1–5. Since integration (Phase 2), the QR must also carry the hash, signature and public key.'),
      ...warnings.map((w) => h('div', { class: 'error-box' }, w)),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'tags' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Tag'), h('th', {}, 'Field'), h('th', {}, 'Bytes'), h('th', {}, 'Value'))),
          h('tbody', {}, ...tags.map((t) => h('tr', {}, h('td', { class: 'n' }, String(t.tag)), h('td', {}, TAG_NAMES[t.tag] ?? 'Unknown'), h('td', { class: 'n' }, String(t.length)), h('td', { class: 'v', dir: 'auto' }, t.value)))),
        ),
      ),
      h('p', { class: 'note' }, 'Tags 6 and 7 are base64 text; tags 8 and 9 are raw DER bytes shown here as base64. Lengths of 128 bytes or more must use BER long form.'),
    );
  } catch (e) {
    out.replaceChildren(h('h2', {}, 'Not a ZATCA QR payload'), h('div', { class: 'error-box' }, (e as Error).message));
  }
}
$('qr-input').addEventListener('input', () => runQr());
$('qr-phase1').addEventListener('click', () => {
  const sample = 'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==';
  $<HTMLTextAreaElement>('qr-input').value = sample;
  runQr(sample);
});
$<HTMLInputElement>('qr-file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const out = $('qr-result');
  if (typeof jsQR !== 'function') {
    out.replaceChildren(h('div', { class: 'error-box' }, 'The QR scanner library did not load. Paste the base64 text instead.'));
    return;
  }
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data.data, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    if (!code) {
      out.replaceChildren(h('h2', {}, 'No QR code found'), h('p', { class: 'hint' }, 'Try a sharper, straight-on image with the whole code visible.'));
      return;
    }
    $<HTMLTextAreaElement>('qr-input').value = code.data;
    runQr(code.data);
  };
  img.onerror = () => out.replaceChildren(h('div', { class: 'error-box' }, 'That file could not be read as an image.'));
  img.src = URL.createObjectURL(file);
});

// ---------- start ----------
renderLines();
syncVisibility();
fromHash();
buildAndSign();
$<HTMLTextAreaElement>('xml-input').value = lastInvoice?.xml ?? '';
runValidate();
