import type { ClearanceLevel } from '../../shared/domain';
import { CLEARANCE_RANK } from '../../shared/domain';
import { snippetAround } from '../lib/text';

/**
 * Deterministic requirement detection. Everything returned here is labeled DERIVED
 * (keyword/pattern detection) with the quoted text as evidence — never as official.
 */
export interface DetectedRequirement {
  category: string;
  text: string;
  quote: string;
}

const CLEARANCE_PATTERNS: { level: ClearanceLevel; re: RegExp }[] = [
  { level: 'ts_sci', re: /\b(TS\s*\/\s*SCI|top\s+secret\s*\/\s*(sensitive\s+compartmented|SCI)|SCI\s+eligib)/i },
  { level: 'top_secret', re: /\btop[\s-]+secret\b(?!\s*\/\s*SCI)/i },
  { level: 'secret', re: /\b(active\s+)?secret\s+(security\s+)?clearance\b|\bclearance\s+(level\s+)?(of\s+)?secret\b|\bsecret[\s-]+level\b|\bfinal\s+secret\b/i },
  { level: 'confidential', re: /\bconfidential\s+(security\s+)?clearance\b/i },
  { level: 'public_trust', re: /\bpublic\s+trust\b|\bMBI\b|\bBI\s+investigation\b|\bTier\s+[2-4][SR]?\b(?=.*(investigation|background))/i },
];

export function detectClearance(text: string): { level: ClearanceLevel; quote: string; facility: boolean } | null {
  if (!text) return null;
  let best: { level: ClearanceLevel; quote: string; facility: boolean } | null = null;
  for (const p of CLEARANCE_PATTERNS) {
    const m = p.re.exec(text);
    if (m && (!best || CLEARANCE_RANK[p.level] > CLEARANCE_RANK[best.level])) {
      const quote = snippetAround(text, m.index, m[0].length, 80);
      best = { level: p.level, quote, facility: /facility\s+(security\s+)?clearance|\bFCL\b|DD\s*(Form\s*)?254/i.test(text) };
    }
  }
  return best;
}

export const CONTRACT_VEHICLES: { name: string; re: RegExp }[] = [
  { name: 'GSA MAS', re: /\b(GSA\s+(MAS|Multiple\s+Award\s+Schedule|Schedule)|Federal\s+Supply\s+Schedule|FSS)\b/i },
  { name: 'OASIS+', re: /\bOASIS\s*\+|\bOASIS\b/i },
  { name: 'Alliant 2/3', re: /\bAlliant\s*(2|3|II|III)?\b/i },
  { name: '8(a) STARS III', re: /\bSTARS\s*(III|3|II|2)?\b/i },
  { name: 'NASA SEWP', re: /\bSEWP\b/i },
  { name: 'NITAAC CIO-SP', re: /\bCIO-SP\s*\d?\b|\bCIO-CS\b/i },
  { name: 'Polaris', re: /\bPolaris\b/i },
  { name: 'VETS 2', re: /\bVETS\s*2\b/i },
  { name: 'T4NG', re: /\bT4NG\d?\b/i },
  { name: 'SeaPort-NxG', re: /\bSeaPort[\s-]*(NxG|e)\b/i },
  { name: 'ITES', re: /\bITES-\w+\b/i },
  { name: 'CMAS', re: /\bCMAS\b/i },
  { name: 'BPA', re: /\bBlanket\s+Purchase\s+Agreement\b|\bBPA\s+call\b/i },
];

export function detectVehicle(text: string): { name: string; quote: string } | null {
  for (const v of CONTRACT_VEHICLES) {
    const m = v.re.exec(text);
    if (m) {
      // Only treat as a requirement when phrased as an ordering restriction.
      const window = text.slice(Math.max(0, m.index - 200), m.index + 200);
      if (/(holders?|awardees?|order(ed|ing)?\s+(under|against|off)|task\s+order|limited\s+to|issued\s+(under|against)|on\s+the|via|through)/i.test(window)) {
        return { name: v.name, quote: snippetAround(text, m.index, m[0].length, 80) };
      }
    }
  }
  return null;
}

export function detectOnsite(text: string): { onsite: boolean; remoteAllowed: boolean; quote: string | null } {
  const onsite = /\b(on[\s-]?site|onsite|in[\s-]person|government\s+facilit(y|ies)|place\s+of\s+performance\s+(is|will\s+be)\s+(at|the))\b/i.exec(text);
  const remote = /\b(remote(ly)?|telework|virtual(ly)?|off[\s-]?site)\b/i.exec(text);
  return { onsite: !!onsite, remoteAllowed: !!remote, quote: onsite ? snippetAround(text, onsite.index, onsite[0].length, 70) : null };
}

const PATTERNS: { category: string; re: RegExp; label: (m: RegExpExecArray) => string }[] = [
  { category: 'page_limit', re: /\b(not\s+(to\s+)?exceed|shall\s+not\s+exceed|limited\s+to|maximum\s+of)\s+(\d{1,3})\s+pages?\b/gi, label: (m) => `Page limit: ${m[4]} pages` },
  { category: 'page_limit', re: /\b(\d{1,3})[\s-]page\s+(limit|maximum)\b/gi, label: (m) => `Page limit: ${m[1]} pages` },
  { category: 'question_deadline', re: /\bquestions?\s+(are\s+)?(due|must\s+be\s+(submitted|received))\s+(by|no\s+later\s+than)\s+([^.;\n]{4,60})/gi, label: (m) => `Questions due ${m[5].trim()}` },
  { category: 'evaluation_factor', re: /\b(technical\s+approach|technical\s+capability|management\s+approach|past\s+performance|price|cost\/price|key\s+personnel|staffing\s+plan|corporate\s+experience)\s+(will\s+be\s+evaluated|is\s+(more|less|significantly\s+more)\s+important|factor)/gi, label: (m) => `Evaluation factor: ${titleWord(m[1])}` },
  { category: 'evaluation_factor', re: /\b(lowest\s+price\s+technically\s+acceptable|LPTA|best\s+value\s+trade-?off|trade-?off\s+process)\b/gi, label: (m) => `Evaluation basis: ${m[1].toUpperCase() === 'LPTA' ? 'Lowest Price Technically Acceptable' : titleWord(m[1])}` },
  { category: 'contract_type', re: /\b(firm[\s-]fixed[\s-]price|FFP|time[\s-]and[\s-]materials?|T&M|labor[\s-]hour|cost[\s-]plus[\s-]fixed[\s-]fee|CPFF|cost[\s-]plus[\s-]award[\s-]fee|IDIQ|indefinite[\s-]delivery)\b/gi, label: (m) => `Contract type: ${m[1]}` },
  { category: 'submission', re: /\b(submit(ted)?\s+(via|through|to)\s+(e-?mail|email|PIEE|SAM\.gov|eBuy|the\s+portal|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}))/gi, label: (m) => `Submission: ${m[1]}` },
  { category: 'travel', re: /\b(travel\s+(is\s+)?(required|anticipated|may\s+be\s+required)|CONUS\s+travel|OCONUS\s+travel)\b/gi, label: (m) => `Travel: ${m[1]}` },
  { category: 'key_personnel', re: /\bkey\s+personnel\b[^.]{0,120}/gi, label: () => 'Key personnel required' },
  { category: 'certification', re: /\b(CMMI\s+(Level|ML)\s*\d|ISO\s*9001|ISO\s*27001|FedRAMP|CMMC\s+(Level\s*)?\d|PMP\s+certifi\w+|ITIL)\b/gi, label: (m) => `Certification: ${m[1]}` },
  { category: 'mandatory', re: /\b(offerors?\s+(shall|must)\s+[^.]{10,160})/gi, label: (m) => m[1].trim() },
];

function titleWord(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract derived requirements from text with quoted evidence. Deduplicated by (category, text). */
export function extractRuleRequirements(text: string, maxPerCategory = 6): DetectedRequirement[] {
  if (!text) return [];
  const out: DetectedRequirement[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const push = (r: DetectedRequirement) => {
    const key = `${r.category}|${r.text.toLowerCase()}`;
    if (seen.has(key) || (counts.get(r.category) ?? 0) >= maxPerCategory) return;
    seen.add(key);
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    out.push(r);
  };
  const clearance = detectClearance(text);
  if (clearance) push({ category: 'clearance', text: `Security clearance mentioned: ${clearance.level.replace('_', '/').toUpperCase()}${clearance.facility ? ' (facility clearance referenced)' : ''}`, quote: clearance.quote });
  const vehicle = detectVehicle(text);
  if (vehicle) push({ category: 'contract_vehicle', text: `Ordered under contract vehicle: ${vehicle.name}`, quote: vehicle.quote });
  const site = detectOnsite(text);
  if (site.onsite && site.quote) push({ category: 'location', text: site.remoteAllowed ? 'On-site work referenced (remote/telework also mentioned)' : 'On-site work referenced', quote: site.quote });
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = p.re.exec(text)) && guard++ < 40) {
      push({ category: p.category, text: p.label(m).slice(0, 220), quote: snippetAround(text, m.index, m[0].length, 70) });
    }
  }
  return out;
}
