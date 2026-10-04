import type { CompanyContext } from '../scoring/types';

/**
 * Capability-based discovery terms.
 *
 * No government source offers a semantic "capability search", so GovCheck derives plain
 * search terms from the company profile (confirmed capabilities and their keywords,
 * technologies and company keywords) and matches them locally against titles and
 * descriptions — in bulk files, in targeted-search results and in scoring.
 *
 * Single generic words ("support", "management", "data"…) are kept for scoring context
 * but are NOT used as discovery terms, because on their own they would match most of the
 * federal procurement universe. Administrators can inspect the result on the Sources page
 * and edit the underlying capability keywords on the Company page.
 */
export const GENERIC_TERMS = new Set([
  'support',
  'services',
  'service',
  'management',
  'manager',
  'oversight',
  'adoption',
  'roadmap',
  'governance',
  'training',
  'analysis',
  'analytics',
  'reporting',
  'reports',
  'sprint',
  'kanban',
  'data',
  'system',
  'systems',
  'software',
  'program',
  'project',
  'technology',
  'technical',
  'operations',
  'maintenance',
  'consulting',
  'professional',
  'solutions',
  'development',
  'design',
  'planning',
  'engineering',
  'security',
  'testing',
  'integration',
  'research',
  'communication',
  'it',
]);

export interface SearchTerm {
  term: string;
  /** Capability names / "Company keyword" that contributed this term. */
  sources: string[];
  /** True when the term is too generic to drive discovery on its own. */
  generic: boolean;
}

/** Lower-case, collapse whitespace and trim punctuation. Returns null for unusable terms. */
export function normalizeTerm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const original = raw.trim();
  const t = original
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9+#]+$/g, '');
  if (!t) return null;
  const isAcronym = /^[A-Z0-9&/+.-]{3,}$/.test(original);
  if (t.length < 4 && !isAcronym) return null;
  return t;
}

function isGeneric(term: string): boolean {
  if (GENERIC_TERMS.has(term)) return true;
  // Two-word phrases made only of generic words ("program management", "data analysis") are
  // still distinctive enough; single generic words are not.
  return false;
}

/** Build the normalized, de-duplicated term list for a company profile. */
export function buildSearchTerms(co: Pick<CompanyContext, 'capabilities' | 'keywords'>): SearchTerm[] {
  const map = new Map<string, SearchTerm>();
  const add = (raw: string, source: string) => {
    const term = normalizeTerm(raw);
    if (!term) return;
    const existing = map.get(term);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    map.set(term, { term, sources: [source], generic: isGeneric(term) });
  };
  for (const cap of co.capabilities) {
    add(cap.name, cap.name);
    for (const k of cap.keywords) add(k, cap.name);
    for (const t of cap.technologies) add(t, cap.name);
  }
  for (const k of co.keywords) add(k, 'Company keyword');
  return [...map.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/** Terms used to discover work (generic single words excluded). */
export function discoveryTerms(co: Pick<CompanyContext, 'capabilities' | 'keywords'>): string[] {
  return buildSearchTerms(co)
    .filter((t) => !t.generic)
    .map((t) => t.term);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One case-insensitive regular expression matching any term on word boundaries.
 * Longer terms first so "power bi report server" wins over "power bi".
 */
export function termMatcher(terms: string[]): RegExp | null {
  const list = [...new Set(terms.map((t) => t.toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(?<![a-z0-9])(?:${list.map((t) => escapeRe(t).replace(/ /g, '\\s+')).join('|')})(?![a-z0-9])`, 'gi');
}

/** Distinct terms of `matcher` found in `text` (case-insensitive). */
export function matchedTerms(matcher: RegExp | null, text: string | null | undefined, maxChars = 6000): string[] {
  if (!matcher || !text) return [];
  const found = new Set<string>();
  matcher.lastIndex = 0;
  for (const m of text.slice(0, maxChars).matchAll(matcher)) found.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  return [...found];
}
