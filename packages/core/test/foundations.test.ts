import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/c14n.js';
import { parseXml } from '../src/dom.js';
import { Decimal } from '../src/money.js';
import { decodeQr, encodeQr } from '../src/qr.js';

describe('canonicalize (W3C C14N examples)', () => {
  it('matches spec example 3.3: start/end tags, attribute and namespace ordering', () => {
    // From https://www.w3.org/TR/xml-c14n11/#Example-SETags, minus the DTD default attribute.
    const input = `<doc>
   <e1   />
   <e2   ></e2>
   <e3   name = "elem3"   id="elem3"   />
   <e4   name="elem4"   id="elem4"   ></e4>
   <e5 a:attr="out" b:attr="sorted" attr2="all" attr="I'm"
      xmlns:b="http://www.ietf.org"
      xmlns:a="http://www.w3.org"
      xmlns="http://example.org"/>
   <e6 xmlns="" xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="" xmlns:a="http://www.w3.org">
            <e9 xmlns="" xmlns:a="http://www.ietf.org"/>
         </e8>
      </e7>
   </e6>
</doc>`;
    const expected = `<doc>
   <e1></e1>
   <e2></e2>
   <e3 id="elem3" name="elem3"></e3>
   <e4 id="elem4" name="elem4"></e4>
   <e5 xmlns="http://example.org" xmlns:a="http://www.w3.org" xmlns:b="http://www.ietf.org" attr="I'm" attr2="all" b:attr="sorted" a:attr="out"></e5>
   <e6 xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="">
            <e9 xmlns:a="http://www.ietf.org"></e9>
         </e8>
      </e7>
   </e6>
</doc>`;
    expect(canonicalize(parseXml(input))).toBe(expected);
  });

  it('matches spec example 3.4: character escaping and CDATA', () => {
    const input = `<doc>
   <text>First line&#x0d;&#10;Second line</text>
   <value>&#x32;</value>
   <compute><![CDATA[value>"0" && value<"10" ?"valid":"error"]]></compute>
   <compute expr='value>"0" &amp;&amp; value&lt;"10" ?"valid":"error"'>valid</compute>
</doc>`;
    const expected = `<doc>
   <text>First line&#xD;
Second line</text>
   <value>2</value>
   <compute>value&gt;"0" &amp;&amp; value&lt;"10" ?"valid":"error"</compute>
   <compute expr="value>&quot;0&quot; &amp;&amp; value&lt;&quot;10&quot; ?&quot;valid&quot;:&quot;error&quot;">valid</compute>
</doc>`;
    expect(canonicalize(parseXml(input))).toBe(expected);
  });

  it('drops the XML declaration and comments', () => {
    const input = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- top -->\n<a><!-- inner --><b/></a>`;
    expect(canonicalize(parseXml(input))).toBe('<a><b></b></a>');
  });

  it('excludes elements but keeps surrounding whitespace (XPath filter semantics)', () => {
    const input = `<a>\n  <skip><x/></skip>\n  <keep/>\n</a>`;
    const out = canonicalize(parseXml(input), { exclude: (el) => el.localName === 'skip' });
    expect(out).toBe('<a>\n  \n  <keep></keep>\n</a>');
  });

  it('renders inherited namespaces on a canonicalized subtree apex', () => {
    const doc = parseXml('<r xmlns="urn:d" xmlns:p="urn:p"><p:child attr="1"><x/></p:child></r>');
    const child = doc.documentElement!.firstChild as Element;
    expect(canonicalize(child)).toBe('<p:child xmlns="urn:d" xmlns:p="urn:p" attr="1"><x></x></p:child>');
  });
});

describe('Decimal', () => {
  it('adds without float error', () => {
    expect(Decimal.from('0.1').plus('0.2').toFixed(2)).toBe('0.30');
    expect(Decimal.from(0.1).plus(0.2).equals('0.3')).toBe(true);
  });

  it('rounds half-up away from zero', () => {
    expect(Decimal.from('2.345').toFixed(2)).toBe('2.35');
    expect(Decimal.from('2.344').toFixed(2)).toBe('2.34');
    expect(Decimal.from('-2.345').toFixed(2)).toBe('-2.35');
    expect(Decimal.from('0.005').toFixed(2)).toBe('0.01');
  });

  it('computes percentages exactly', () => {
    expect(Decimal.from('100.00').percent(15).toFixed(2)).toBe('15.00');
    expect(Decimal.from('33.33').percent(15).toFixed(2)).toBe('5.00'); // 4.9995 -> 5.00
    expect(Decimal.from('19.99').times('3').toFixed(2)).toBe('59.97');
  });

  it('trims trailing zeros in toString', () => {
    expect(Decimal.from('2.500').toString()).toBe('2.5');
    expect(Decimal.from('3').toString(2)).toBe('3.00');
  });

  it('rejects junk', () => {
    expect(() => Decimal.from('12,50')).toThrow();
    expect(() => Decimal.from('abc')).toThrow();
  });
});

describe('QR TLV', () => {
  it('reproduces ZATCA\'s published Phase 1 example payload', () => {
    const qr = encodeQr({
      sellerName: 'Bobs Records',
      vatNumber: '310122393500003',
      timestamp: '2022-04-25T15:30:00Z',
      totalWithVat: '1000.00',
      vatTotal: '150.00',
    });
    expect(qr).toBe('AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==');
  });

  it('round-trips Arabic text and binary tags', () => {
    const publicKey = new Uint8Array([0x30, 0x56, 0x30, 0x10, 1, 2, 3]);
    const qr = encodeQr({
      sellerName: 'شركة التوريدات',
      vatNumber: '399999999900003',
      timestamp: '2026-11-10T14:05:00',
      totalWithVat: '1150.00',
      vatTotal: '150.00',
      invoiceHash: 'abc=',
      signature: 'sig=',
      publicKey,
    });
    const { fields, tags } = decodeQr(qr);
    expect(fields.sellerName).toBe('شركة التوريدات');
    expect(fields.invoiceHash).toBe('abc=');
    expect(fields.publicKey).toEqual(publicKey);
    expect(tags.map((t) => t.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects truncated payloads', () => {
    // Tag 1 claims 12 bytes but only 3 follow.
    expect(() => decodeQr(btoa(String.fromCharCode(1, 12, 65, 66, 67)))).toThrow(/declares 12 bytes/);
  });
});
