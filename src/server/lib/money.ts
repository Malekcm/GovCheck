/** Parse "$1,234.56", "1234", "4.8M", "$5M - $9.9M", "Under $250K", "Over $100M" into a numeric range. */
export interface MoneyRange {
  low: number | null;
  high: number | null;
}

function unit(n: number, u: string | undefined): number {
  switch ((u ?? '').toUpperCase()) {
    case 'K':
      return n * 1_000;
    case 'M':
    case 'MM':
      return n * 1_000_000;
    case 'B':
      return n * 1_000_000_000;
    default:
      return n;
  }
}

export function parseMoney(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const m = /(-?[\d,]*\.?\d+)\s*(K|MM|M|B)?\b/i.exec(String(input).replace(/\$/g, ''));
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? unit(n, m[2]) : null;
}

export function parseMoneyRange(input: unknown): MoneyRange {
  if (input === null || input === undefined || input === '') return { low: null, high: null };
  const s = String(input).replace(/\$/g, '').trim();
  const nums = [...s.matchAll(/(-?[\d,]*\.?\d+)\s*(K|MM|M|B)?\b/gi)].map((m) => unit(Number.parseFloat(m[1].replace(/,/g, '')), m[2]));
  if (!nums.length) return { low: null, high: null };
  if (/under|less than|below|up to|</i.test(s)) return { low: 0, high: nums[0] };
  if (/over|more than|above|greater|\+|>/i.test(s) && nums.length === 1) return { low: nums[0], high: null };
  if (nums.length >= 2) return { low: Math.min(nums[0], nums[1]), high: Math.max(nums[0], nums[1]) };
  return { low: nums[0], high: nums[0] };
}

export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low == null && high == null) return '—';
  if (low != null && high != null && low !== high) return `${formatMoney(low)}–${formatMoney(high)}`;
  return formatMoney(high ?? low);
}
