/**
 * Exact decimal arithmetic for invoice amounts.
 *
 * Amounts are held as bigint values scaled to a fixed number of decimal places, so
 * 0.1 + 0.2 is exactly 0.3 and rounding is always half-up (away from zero), never
 * binary-float rounding. This matters because ZATCA re-computes totals and rejects
 * invoices whose amounts are off by a single halala.
 */

const INTERNAL_SCALE = 6; // enough for unit prices and quantities with decimals
const FACTOR = 10n ** BigInt(INTERNAL_SCALE);

export class Decimal {
  private constructor(private readonly units: bigint) {}

  static from(value: Decimal | string | number | bigint): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(value * FACTOR);
    const str = typeof value === 'number' ? numberToPlainString(value) : value.trim();
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(str);
    if (!m) throw new Error(`Not a decimal number: "${value}"`);
    const [, sign, intPart, fracRaw = ''] = m;
    const frac = fracRaw.slice(0, INTERNAL_SCALE).padEnd(INTERNAL_SCALE, '0');
    let units = BigInt(intPart!) * FACTOR + BigInt(frac);
    // Round half-up on any digits beyond the internal scale.
    const extra = fracRaw.slice(INTERNAL_SCALE);
    if (extra.length > 0 && extra.charCodeAt(0) >= 53 /* '5' */) units += 1n;
    return new Decimal(sign === '-' ? -units : units);
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }

  plus(other: Decimal | string | number): Decimal {
    return new Decimal(this.units + Decimal.from(other).units);
  }

  minus(other: Decimal | string | number): Decimal {
    return new Decimal(this.units - Decimal.from(other).units);
  }

  times(other: Decimal | string | number): Decimal {
    const product = this.units * Decimal.from(other).units;
    return new Decimal(divRoundHalfUp(product, FACTOR));
  }

  /** Multiply by a percentage, e.g. 15 -> 15%. */
  percent(rate: Decimal | string | number): Decimal {
    const product = this.units * Decimal.from(rate).units;
    return new Decimal(divRoundHalfUp(product, FACTOR * 100n));
  }

  /** Round half-up (away from zero) to `places` decimal places. */
  round(places = 2): Decimal {
    if (places >= INTERNAL_SCALE) return this;
    const step = 10n ** BigInt(INTERNAL_SCALE - places);
    return new Decimal(divRoundHalfUp(this.units, step) * step);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  compare(other: Decimal | string | number): number {
    const o = Decimal.from(other).units;
    return this.units < o ? -1 : this.units > o ? 1 : 0;
  }

  equals(other: Decimal | string | number): boolean {
    return this.compare(other) === 0;
  }

  abs(): Decimal {
    return this.units < 0n ? new Decimal(-this.units) : this;
  }

  /** Format with exactly `places` decimals (rounding half-up), e.g. "1150.00". */
  toFixed(places = 2): string {
    const rounded = this.round(places).units;
    const negative = rounded < 0n;
    const abs = negative ? -rounded : rounded;
    const intPart = abs / FACTOR;
    const fracPart = (abs % FACTOR).toString().padStart(INTERNAL_SCALE, '0').slice(0, places);
    const body = places > 0 ? `${intPart}.${fracPart}` : `${intPart}`;
    return negative ? `-${body}` : body;
  }

  /** Shortest exact representation, trimming trailing zeros (min `minPlaces` decimals). */
  toString(minPlaces = 0): string {
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const intPart = abs / FACTOR;
    let frac = (abs % FACTOR).toString().padStart(INTERNAL_SCALE, '0').replace(/0+$/, '');
    if (frac.length < minPlaces) frac = frac.padEnd(minPlaces, '0');
    const body = frac.length > 0 ? `${intPart}.${frac}` : `${intPart}`;
    return negative ? `-${body}` : body;
  }
}

export function sum(values: Iterable<Decimal>): Decimal {
  let total = Decimal.zero();
  for (const v of values) total = total.plus(v);
  return total;
}

function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return negative ? -q : q;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  // Avoid exponent notation for very small/large numbers.
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  return n.toFixed(INTERNAL_SCALE + 2);
}
