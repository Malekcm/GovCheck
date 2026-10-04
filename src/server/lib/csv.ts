/**
 * CSV helpers for exports. Text from government sources (titles, descriptions, contact
 * names) is untrusted: a value beginning with =, +, @ or - can be executed as a formula
 * when the file is opened in Excel/Sheets ("CSV injection"). Such cells are prefixed with
 * an apostrophe so they display as text. Plain negative numbers are left alone.
 */
export function neutralizeFormula(s: string): string {
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d[\d,.]*$/.test(s))) return `'${s}`;
  return s;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' || Array.isArray(v) || typeof v === 'object') s = neutralizeFormula(s);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], cols: [string, (r: T) => unknown][]): string {
  const lines = [cols.map(([h]) => csvCell(h)).join(','), ...rows.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','))];
  // BOM so Excel opens UTF-8 correctly.
  return `\ufeff${lines.join('\r\n')}`;
}
