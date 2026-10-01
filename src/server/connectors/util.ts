/** Map free-text set-aside descriptions (forecasts, feeds) to SAM set-aside codes. Returns null when unknown/none. */
export function setAsideFromText(text: string | null | undefined): { code: string | null; label: string | null } {
  if (!text) return { code: null, label: null };
  const t = text.toLowerCase();
  const label = text.trim();
  if (/to be determined|tbd|unknown/.test(t)) return { code: null, label };
  if (/full and open|unrestricted|no set.?aside|none/.test(t) && !/small/.test(t)) return { code: null, label };
  if (/edwosb|economically disadvantaged wom/.test(t)) return { code: 'EDWOSB', label };
  if (/wosb|women.?owned/.test(t)) return { code: 'WOSB', label };
  if (/sdvosb|service.?disabled/.test(t)) return { code: 'SDVOSBC', label };
  if (/hub.?zone/.test(t)) return { code: 'HZC', label };
  if (/8\s*\(?a\)?/.test(t)) return { code: /sole/.test(t) ? '8AN' : '8A', label };
  if (/veteran/.test(t)) return { code: 'VSA', label };
  if (/partial small/.test(t)) return { code: 'SBP', label };
  if (/small business|\bsb\b|total small/.test(t)) return { code: 'SBA', label };
  return { code: null, label };
}

export const US_STATES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'PUERTO RICO': 'PR', GUAM: 'GU',
  'VIRGIN ISLANDS': 'VI', 'AMERICAN SAMOA': 'AS', 'NORTHERN MARIANA ISLANDS': 'MP',
};

export function stateCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = input.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(t)) return t;
  return US_STATES[t] ?? null;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
