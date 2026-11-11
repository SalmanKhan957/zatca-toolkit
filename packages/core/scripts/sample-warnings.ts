import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateInvoice } from '../src/validate.js';
const dir = join(import.meta.dirname, '../../../reference-samples/zatca-sdk/extracted/zatca-einvoicing-sdk-Java-238-R3.4.8/Data/Samples');
const list = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? list(p) : n.endsWith('.xml') ? [p] : []; });
for (const f of list(dir)) {
  const r = validateInvoice(readFileSync(f, 'utf8'));
  const w = r.warnings.map((x) => `${x.code}${x.detail ? ` (${x.detail})` : ''}`);
  console.log(`${f.split(/[\/]/).slice(-2).join('/')}: ${w.length ? w.join('; ') : 'no warnings'}`);
}
