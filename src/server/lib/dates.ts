const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Parse the many date formats government sources use into a Date (UTC instant).
 * Returns null for anything unparseable rather than guessing.
 */
export function parseDate(input: unknown): Date | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    // epoch seconds (Drupal) vs milliseconds
    const d = new Date(input < 1e12 ? input * 1000 : input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return parseDate(Number(s));

  // YYYY-MM-DD (date only) -> noon UTC to avoid timezone day shifts
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));

  // YYYY-MM-DD HH:mm:ss (no zone) -> treat as US Eastern-ish; use UTC to stay deterministic
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));

  // MM/DD/YYYY [HH:mm]
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(s);
  if (m) {
    let h = m[4] ? +m[4] : 12;
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
  }

  // "Sep 21, 2026 12:00:00 AM EDT" (Grants.gov)
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*([A-Z]{2,4})?)?/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    let h = m[4] ? +m[4] : 12;
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    const tzOffset = m[8] ? ({ EST: 5, EDT: 4, CST: 6, CDT: 5, MST: 7, MDT: 6, PST: 8, PDT: 7, UTC: 0, GMT: 0 } as Record<string, number>)[m[8]] ?? 0 : 0;
    const noTime = !m[4];
    return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], noTime ? 12 : h + tzOffset, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso(input: unknown): string | null {
  const d = parseDate(input);
  return d ? d.toISOString() : null;
}

export function toDateOnly(input: unknown): string | null {
  const d = parseDate(input);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** SAM.gov query format MM/dd/yyyy */
export function toSamDate(d: Date): string {
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

export function monthsBetween(a: Date, b: Date): number {
  return daysBetween(a, b) / 30.4375;
}

/** US federal fiscal year containing the date (FY starts Oct 1). */
export function fiscalYear(d: Date): number {
  return d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

/** Start/end instants of a federal fiscal year (optionally a quarter 1-4). */
export function fiscalPeriod(fy: number, quarter?: number): { start: Date; end: Date } {
  if (!quarter) return { start: new Date(Date.UTC(fy - 1, 9, 1)), end: new Date(Date.UTC(fy, 8, 30, 23, 59)) };
  const startMonth = (9 + (quarter - 1) * 3) % 12;
  const startYear = quarter === 1 ? fy - 1 : fy;
  const start = new Date(Date.UTC(startYear, startMonth, 1));
  const end = addDays(addMonths(start, 3), -1);
  return { start, end };
}
