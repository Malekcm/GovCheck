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
  /** explicit = phrased as an obligation; mentioned = referenced without an obligation. */
  strength?: 'explicit' | 'mentioned';
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
  { category: 'certification', re: /\b(CMMI\s+(Level|ML)\s*\d|ISO\s*9001|ISO\s*27001|ISO\s*20000|PMP\s+certifi\w+|ITIL|AS\s*9100)\b/gi, label: (m) => `Certification: ${m[1]}` },
  { category: 'security_compliance', re: /\bCMMC\s*(2\.0\s*)?(Level\s*|L)?([1-3])\b/gi, label: (m) => `CMMC Level ${m[3]}` },
  { category: 'security_compliance', re: /\bFedRAMP(\s+(High|Moderate|Low|Li-?SaaS|Tailored))?(\s+(authori[sz]ation|authori[sz]ed|ATO|P-?ATO))?\b/gi, label: (m) => `FedRAMP${m[2] ? ` ${titleWord(m[2])}` : ''}${m[4] ? ' authorization' : ''}` },
  { category: 'security_compliance', re: /\bNIST\s*(SP\s*)?800-(171|53|37|161|207)\b/gi, label: (m) => `NIST SP 800-${m[2]}` },
  { category: 'security_compliance', re: /\b(DFARS\s*252\.204-70(12|19|20|21))\b/gi, label: (m) => `Cyber clause ${m[1].replace(/\s+/g, ' ')}` },
  { category: 'security_compliance', re: /\bFISMA\b/g, label: () => 'FISMA compliance' },
  { category: 'security_compliance', re: /\bSection\s*508\b/gi, label: () => 'Section 508 accessibility' },
  { category: 'security_compliance', re: /\b(IL[2456]|Impact\s+Level\s+[2456])\b/g, label: (m) => `DoD cloud ${m[1].replace(/Impact\s+Level\s+/i, 'IL')}` },
  { category: 'facility_clearance', re: /\b(DD\s*(Form\s*)?254|facility\s+(security\s+)?clearance|\bFCL\b)/gi, label: () => 'Facility clearance / DD-254 referenced' },
  { category: 'citizenship', re: /\b(U\.?\s?S\.?\s+citizen(s|ship)?(\s+(is|are)\s+required|\s+only)?|must\s+be\s+(a\s+)?U\.?\s?S\.?\s+citizens?)\b/gi, label: () => 'U.S. citizenship requirement' },
  { category: 'experience', re: /\b(minimum\s+(of\s+)?)?(\d{1,2})\+?\s*(years|yrs)\.?\s+(of\s+)?((\w+[\s/-]){0,4})experience\b/gi, label: (m) => `${m[3]}+ years ${m[6].trim() ? `${m[6].trim()} ` : ''}experience` },
  { category: 'past_performance_requirement', re: /\b(\d{1,2}|one|two|three|four|five)\s+(\(\d\)\s+)?(recent\s+and\s+relevant\s+|relevant\s+)?(past\s+performance\s+(references|examples|projects|citations)|contracts?\s+of\s+similar\s+(size|scope))/gi, label: (m) => `Past performance: ${m[0].trim()}` },
  { category: 'bonding_insurance', re: /\b((bid|performance|payment)\s+bonds?|bonding\s+capacity|(general\s+liability|professional\s+liability|workers'?\s+compensation|errors\s+and\s+omissions)\s+insurance)\b/gi, label: (m) => `Bonding/insurance: ${m[1]}` },
  { category: 'transition', re: /\b(phase[\s-]in\s+(period|plan)|transition[\s-]in(\s+(period|plan))?|transition\s+(plan|period)|incumbent\s+capture)\b/gi, label: (m) => `Transition: ${m[1]}` },
  { category: 'subcontracting_limit', re: /\b(limitations?\s+on\s+subcontracting|FAR\s*52\.219-14|50\s*(%|percent)\s+of\s+the\s+(cost|amount\s+paid))\b/gi, label: () => 'Limitations on subcontracting apply (prime must self-perform a minimum share)' },
  { category: 'sole_source', re: /\b(intent(ion)?\s+to\s+(award|negotiate|issue)[^.]{0,80}sole[\s-]source|sole[\s-]source\s+(award|basis|procurement|acquisition|contract)|notice\s+of\s+intent\s+to\s+sole[\s-]source|other\s+than\s+full\s+and\s+open\s+competition)\b/gi, label: () => 'Intent to award sole source / other than full and open competition' },
  { category: 'incumbent_mention', re: /\b(the\s+)?(current|incumbent)\s+(contractor|vendor)\s+(is|was)\s+([A-Z][A-Za-z0-9&.,' -]{2,60}?)(?=[.;,(\n]|\s+under|\s+on)/g, label: (m) => `Incumbent named in text: ${m[5].trim()}` },
  { category: 'staffing', re: /\b(approximately|estimated|up\s+to|minimum\s+of)\s+(\d{1,4})\s+(FTEs?|full[\s-]time\s+equivalents?|personnel|staff|contractor\s+employees)\b/gi, label: (m) => `Staffing: ${m[1]} ${m[2]} ${m[3]}` },
  { category: 'mandatory', re: /\b(offerors?\s+(shall|must)\s+[^.]{10,160})/gi, label: (m) => m[1].trim() },
];

function titleWord(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const EXPLICIT_RE = /\b(shall|must|required|mandatory|will\s+be\s+required|is\s+required|are\s+required|minimum|no\s+later\s+than|only)\b/i;

/** "Explicit" when the evidence is phrased as an obligation; otherwise the text merely mentions it. */
export function requirementStrength(quote: string, category: string): 'explicit' | 'mentioned' {
  if (['page_limit', 'question_deadline', 'submission', 'subcontracting_limit', 'sole_source', 'mandatory'].includes(category)) return 'explicit';
  return EXPLICIT_RE.test(quote) ? 'explicit' : 'mentioned';
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
  for (const r of out) r.strength = requirementStrength(r.quote, r.category);
  return out;
}
