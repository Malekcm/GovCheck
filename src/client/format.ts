export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function moneyRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low == null && high == null) return '—';
  if (low != null && high != null && Number(low) !== Number(high)) return `${money(low)}–${money(high)}`;
  return money(high ?? low);
}

export function date(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return withTime
    ? x.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relative(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const ms = new Date(d).getTime() - Date.now();
  const abs = Math.abs(ms);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [365 * 86400e3, 'year'],
    [30 * 86400e3, 'month'],
    [7 * 86400e3, 'week'],
    [86400e3, 'day'],
    [3600e3, 'hour'],
    [60e3, 'minute'],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [size, unit] of units) if (abs >= size) return rtf.format(Math.round(ms / size), unit);
  return 'just now';
}

export function daysUntil(d: string | null | undefined): number | null {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400e3);
}

export function titleize(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(Number(n) * 100)}%`;
}
