/**
 * Identifier normalization for entity resolution.
 *
 * Rules (deliberately conservative):
 *  - Trim and upper-case.
 *  - For contract-style identifiers (solicitation numbers, PIIDs, award numbers)
 *    remove spaces, hyphens, periods and underscores. FAR 4.1601–4.1603 PIIDs are
 *    alphanumeric; separators are display formatting (SAM shows "W912DY-24-R-0001",
 *    FPDS/USAspending store "W912DY24R0001"), so stripping them is defensible.
 *    Slashes and other characters are KEPT because they can be meaningful.
 *  - Opaque system IDs (SAM notice IDs, UUIDs, grant numeric IDs) are only
 *    trimmed and upper-cased.
 *  - Placeholder values ("N/A", "TBD", "NONE"...) and values shorter than 5
 *    characters are never used for matching — they would create false merges.
 */
export type IdentifierType =
  | 'notice_id'
  | 'solicitation_number'
  | 'piid'
  | 'award_number'
  | 'idv_piid'
  | 'predecessor_piid'
  | 'forecast_id'
  | 'source_listing_id'
  | 'grant_number'
  | 'grant_id'
  | 'subnet_id'
  | 'usaspending_award_id'
  | 'feed_item_id';

const CONTRACT_STYLE = new Set<IdentifierType>(['solicitation_number', 'piid', 'award_number', 'idv_piid', 'predecessor_piid', 'source_listing_id']);

const PLACEHOLDERS = new Set(['NA', 'N/A', 'NONE', 'TBD', 'TBA', 'NULL', 'UNKNOWN', 'NOTAPPLICABLE', 'PENDING', '0', '00000']);

export function normalizeIdentifier(type: IdentifierType, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let v = String(value).trim().toUpperCase();
  if (!v) return null;
  if (CONTRACT_STYLE.has(type)) v = v.replace(/[\s\-._]+/g, '');
  if (PLACEHOLDERS.has(v) || PLACEHOLDERS.has(v.replace(/[^A-Z0-9/]/g, ''))) return null;
  if (CONTRACT_STYLE.has(type) && v.length < 5) return null;
  return v;
}

/**
 * Identifier types that refer to the same real-world identifier space and may be
 * matched against each other (e.g. a SAM award notice's "award number" is the
 * contract PIID that USAspending reports).
 */
export const MATCH_GROUPS: Record<string, IdentifierType[]> = {
  notice: ['notice_id'],
  solicitation: ['solicitation_number'],
  contract: ['piid', 'award_number'],
  forecast: ['forecast_id'],
  grant_number: ['grant_number'],
  grant_id: ['grant_id'],
  subnet: ['subnet_id'],
  usaspending: ['usaspending_award_id'],
  feed: ['feed_item_id'],
};

export function matchGroupOf(type: IdentifierType): IdentifierType[] | null {
  for (const types of Object.values(MATCH_GROUPS)) if (types.includes(type)) return types;
  return null;
}

/** Identifier types strong enough to auto-link records into one profile. */
export const STRONG_IDENTIFIER_TYPES: IdentifierType[] = ['notice_id', 'solicitation_number', 'piid', 'award_number', 'forecast_id', 'grant_number', 'grant_id', 'subnet_id', 'usaspending_award_id', 'feed_item_id'];
