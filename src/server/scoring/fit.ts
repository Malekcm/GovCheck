import { SCORE_COMPONENTS, STAGE_LABELS, type ScoreComponent, type Stage } from '../../shared/domain';
import { detectOnsite } from '../ai/rules';
import { formatMoney, formatRange } from '../lib/money';
import { findPhrase, nameKey, snippetAround } from '../lib/text';
import { evaluateEligibility } from './eligibility';
import { companyCorpus } from './profile';
import { TfIdfModel } from './similarity';
import type { CompanyContext, ComponentResult, FitResult, MatchedCapability, OppForScoring } from './types';

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

function agencyMatches(list: string[], opp: OppForScoring): string | null {
  const keys = [opp.department, opp.subtier, opp.office].map((x) => nameKey(x)).filter(Boolean);
  for (const a of list) {
    const k = nameKey(a);
    if (k && keys.some((x) => x === k || x.includes(k) || k.includes(x))) return a;
  }
  return null;
}

function locationMatches(list: string[], opp: OppForScoring): string | null {
  const st = (opp.placeState ?? '').toUpperCase();
  const city = (opp.placeCity ?? '').toUpperCase();
  for (const l of list) {
    const u = l.trim().toUpperCase();
    if (!u) continue;
    if (u === st || (city && city.includes(u)) || (u.length > 3 && city && u.includes(city))) return l;
    if (u === 'REMOTE' || u === 'NATIONWIDE' || u === 'CONUS') return l;
  }
  return null;
}

/** Find which confirmed capabilities the opportunity text calls for, with quoted evidence. */
export function matchCapabilities(opp: OppForScoring, co: CompanyContext): MatchedCapability[] {
  const title = opp.title;
  const titleLower = title.toLowerCase();
  const body = opp.text;
  const bodyLower = body.toLowerCase();
  const out: MatchedCapability[] = [];
  for (const cap of co.capabilities) {
    const terms = [...new Set([cap.name, ...cap.keywords, ...cap.technologies])].filter((t) => t && t.length >= 2);
    let best: MatchedCapability | null = null;
    for (const term of terms) {
      // Very short acronyms (BI, QA, UX) only count when they appear as whole words in the title or as exact tokens.
      if (term.length <= 3 && !/^[A-Z0-9#.+/&]+$/.test(term)) continue;
      const ti = findPhrase(titleLower, term);
      if (ti >= 0) {
        best = { capabilityId: cap.id, slug: cap.slug, name: cap.name, category: cap.category, strength: cap.strength, matchedTerm: term, inTitle: true, evidence: snippetAround(title, ti, term.length, 60) };
        break;
      }
      if (!best) {
        const bi = findPhrase(bodyLower, term);
        if (bi >= 0) best = { capabilityId: cap.id, slug: cap.slug, name: cap.name, category: cap.category, strength: cap.strength, matchedTerm: term, inTitle: false, evidence: snippetAround(body, bi, term.length, 80) };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.strength - a.strength);
}

function durationMonths(opp: OppForScoring): number | null {
  if (!opp.performanceStart || !opp.performanceEnd) return null;
  const m = (new Date(opp.performanceEnd).getTime() - new Date(opp.performanceStart).getTime()) / (30.4375 * 86_400_000);
  return m > 0 ? m : null;
}

/**
 * Explainable BASE COMPANY FIT. Each component earns points against its configured
 * weight; every point earned or lost is explained. This score is objective with
 * respect to the profile and is never altered by learned preferences.
 */
export function scoreOpportunity(opp: OppForScoring, co: CompanyContext, model: TfIdfModel, now = new Date()): FitResult {
  const comps: ComponentResult[] = [];
  const strengths: string[] = [];
  const gaps: string[] = [];
  const w = co.weights;
  const add = (component: ScoreComponent, ratio: number, explanation: string[]) => {
    const max = w[component] ?? 0;
    const r = clamp(ratio);
    comps.push({ component, weight: max, points: Number((r * max).toFixed(1)), max, ratio: Number(r.toFixed(3)), explanation });
  };
  const fullText = `${opp.title}\n${opp.text}`;

  // 1. Capability match
  const matched = matchCapabilities(opp, co);
  {
    const exp: string[] = [];
    if (!co.capabilities.length) {
      exp.push('No confirmed capabilities in the company profile yet — check off what you can do to enable capability matching.');
      add('capability', 0, exp);
    } else {
      const s = matched.reduce((acc, m) => acc + (m.strength / 5) * (m.inTitle ? 1.6 : 1), 0);
      const ratio = 1 - Math.exp(-s / 1.6);
      for (const m of matched.slice(0, 8)) exp.push(`${m.name} ✓ (strength ${m.strength}/5) — “${m.matchedTerm}” ${m.inTitle ? 'in title' : 'in description'}`);
      if (!matched.length) exp.push('None of your confirmed capabilities are referenced in the available text.');
      else if (matched.length > 8) exp.push(`…and ${matched.length - 8} more matched capabilities.`);
      add('capability', ratio, exp);
      if (matched.length) strengths.push(`Requested work matches ${matched.length} of your capabilities: ${matched.slice(0, 4).map((m) => m.name).join(', ')}${matched.length > 4 ? '…' : ''}`);
    }
  }

  // 2. Scope / technical similarity
  let scopeTerms: string[] = [];
  {
    const corpus = companyCorpus(co);
    if (!corpus.trim() || opp.text.length + opp.title.length < 40) {
      add('scope', corpus.trim() ? 0.3 : 0, [corpus.trim() ? 'Too little scope text to compare reliably; partial credit given.' : 'Company profile has no capability/past performance text to compare against.']);
    } else {
      const ov = model.vector(fullText);
      const cv = model.vector(corpus);
      const sim = model.cosine(ov, cv);
      scopeTerms = model.topSharedTerms(ov, cv, 8);
      const ratio = clamp(sim / 0.28);
      add('scope', ratio, [`Scope similarity to your capabilities and past work: ${Math.round(sim * 100)}%${scopeTerms.length ? ` (shared terms: ${scopeTerms.join(', ')})` : ''}.`]);
      if (ratio >= 0.7) strengths.push('Strong scope similarity to your capability profile');
      else if (ratio < 0.25) gaps.push('Scope language differs substantially from your capabilities');
    }
  }

  // 3. Past performance
  {
    if (!co.pastPerformance.length) {
      add('past_performance', 0, ['No past performance entered — add projects to enable this component.']);
    } else {
      let best = { ratio: 0, exp: '' };
      const ov = model.vector(fullText);
      for (const p of co.pastPerformance) {
        let r = clamp(model.cosine(ov, model.vector(p.text)) / 0.3) * 0.7;
        const why: string[] = [`“${p.name}” scope similarity ${Math.round(model.cosine(ov, model.vector(p.text)) * 100)}%`];
        if (p.agency && agencyMatches([p.agency], opp)) {
          r += 0.15;
          why.push('same agency');
        }
        if (opp.naics && p.naics.includes(opp.naics)) {
          r += 0.1;
          why.push(`same NAICS ${opp.naics}`);
        }
        const ov2 = opp.valueHigh ?? opp.valueLow;
        if (p.value && ov2 && p.value >= ov2 * 0.3) {
          r += 0.05;
          why.push(`comparable size (${formatMoney(p.value)})`);
        }
        if (r > best.ratio) best = { ratio: r, exp: why.join(', ') };
      }
      add('past_performance', best.ratio, [best.exp ? `Closest project: ${best.exp}.` : 'No similar project found.']);
      if (best.ratio >= 0.6) strengths.push(`Relevant past performance: ${best.exp.split(' scope')[0]}`);
      else gaps.push('Past performance relevance is weak or unclear');
    }
  }

  // 4. NAICS / PSC / agency alignment
  {
    let r = 0;
    const exp: string[] = [];
    const naicsAll = [opp.naics, ...opp.naicsCodes].filter(Boolean) as string[];
    if (naicsAll.length && co.naics.length) {
      if (naicsAll.some((n) => co.naics.includes(n))) {
        r += 0.5;
        exp.push(`NAICS ${naicsAll.find((n) => co.naics.includes(n))} is in your profile (+)`);
      } else if (naicsAll.some((n) => co.naics.some((c) => c.slice(0, 4) === n.slice(0, 4)))) {
        r += 0.3;
        exp.push(`NAICS ${naicsAll[0]} is in the same industry group as your codes`);
      } else if (naicsAll.some((n) => co.naics.some((c) => c.slice(0, 2) === n.slice(0, 2)))) {
        r += 0.1;
        exp.push(`NAICS ${naicsAll[0]} shares only the sector with your codes`);
      } else exp.push(`NAICS ${naicsAll[0]} is outside your codes`);
    } else if (!naicsAll.length) {
      r += 0.2;
      exp.push('NAICS not provided by the source (neutral)');
    } else exp.push('No NAICS codes in your profile');
    if (opp.psc && co.psc.length) {
      if (co.psc.includes(opp.psc)) {
        r += 0.2;
        exp.push(`PSC ${opp.psc} matches your preferences`);
      } else if (co.psc.some((p) => p.slice(0, 2) === opp.psc!.slice(0, 2))) {
        r += 0.1;
        exp.push(`PSC ${opp.psc} is in a preferred PSC group`);
      }
    } else if (opp.psc) r += 0.05;
    const pref = agencyMatches(co.preferredAgencies, opp);
    const excl = agencyMatches(co.excludedAgencies, opp);
    if (excl) {
      r = 0;
      exp.push(`Agency is on your EXCLUDED list (${excl})`);
      gaps.push(`Excluded agency: ${excl}`);
    } else if (pref) {
      r += 0.3;
      exp.push(`Preferred agency (${pref})`);
      strengths.push(`Preferred agency: ${pref}`);
    } else r += 0.1;
    add('alignment', r, exp);
  }

  // 5. Value fit
  {
    const lo = opp.valueLow;
    const hi = opp.valueHigh ?? opp.valueLow;
    const v = hi != null && lo != null ? (hi + lo) / 2 : hi ?? lo;
    const exp: string[] = [];
    if (v == null) {
      add('value', 0.5, ['No value information yet (neutral). See Financial Intelligence for historical context.']);
    } else {
      const label = `${opp.valueLabel ?? 'Value'} ${formatRange(lo, hi)}${opp.valueProvenance && opp.valueProvenance !== 'official' ? ` (${opp.valueProvenance.replace('_', ' ')})` : ''}`;
      let r = 1;
      if (co.minValue && v < co.minValue) {
        r = clamp(v / co.minValue) * 0.6;
        exp.push(`${label} is below your minimum worthwhile value (${formatMoney(co.minValue)})`);
        gaps.push('Below your minimum contract value');
      } else if (co.maxRealisticValue && v > co.maxRealisticValue) {
        r = clamp(co.maxRealisticValue / v) * 0.4;
        exp.push(`${label} is above your maximum realistic project size (${formatMoney(co.maxRealisticValue)})`);
        gaps.push('Contract appears significantly larger than your realistic maximum');
      } else if (co.preferredMaxValue && v > co.preferredMaxValue) {
        r = 0.65;
        exp.push(`${label} exceeds your preferred maximum (${formatMoney(co.preferredMaxValue)}) but is within your realistic maximum`);
      } else {
        exp.push(`${label} is within your target range`);
        if (co.minValue || co.preferredMaxValue) strengths.push('Contract size fits your target range');
      }
      if (opp.valueProvenance === 'estimated' || opp.valueProvenance === 'derived') r = 0.5 + (r - 0.5) * 0.6; // less confidence in inferred values
      if (!co.minValue && !co.preferredMaxValue && !co.maxRealisticValue) {
        r = 0.6;
        exp.push('Set contract size preferences in the profile to evaluate value fit');
      }
      add('value', r, exp);
    }
  }

  // 6. Location / delivery
  {
    const exp: string[] = [];
    let r: number;
    const site = detectOnsite(fullText);
    const excluded = locationMatches(co.excludedLocations, opp);
    const preferred = locationMatches([...co.preferredLocations, ...co.serviceArea], opp);
    if (excluded) {
      r = 0;
      exp.push(`Place of performance is in an excluded location (${excluded})`);
      gaps.push(`Excluded location: ${excluded}`);
    } else if (preferred) {
      r = 1;
      exp.push(`Place of performance (${[opp.placeCity, opp.placeState].filter(Boolean).join(', ')}) is in your preferred/service area`);
    } else if (!opp.placeState && !opp.placeCity) {
      r = co.remoteCapable ? 0.8 : 0.6;
      exp.push('Place of performance not specified');
    } else {
      r = co.remoteCapable && site.remoteAllowed ? 0.8 : 0.45;
      exp.push(`Place of performance ${[opp.placeCity, opp.placeState].filter(Boolean).join(', ')} is outside your listed areas`);
    }
    if (site.onsite && co.onsiteCapable === false) {
      r = Math.min(r, 0.2);
      exp.push('On-site work referenced; your profile says on-site work is not possible');
      gaps.push('On-site requirement');
    } else if (site.onsite && co.travelWillingness === 'none' && !preferred) {
      r = Math.min(r, 0.35);
      exp.push('On-site work referenced outside your area and you prefer no travel');
    }
    add('location', r, exp);
  }

  // 7. Timeline / capacity
  {
    const exp: string[] = [];
    let r = 0.8;
    const stage = opp.stage as Stage;
    if (opp.deadline) {
      const days = (new Date(opp.deadline).getTime() - now.getTime()) / 86_400_000;
      if (days < 0) {
        r = stage === 'award' ? 0.3 : 0;
        exp.push(`Response deadline passed ${Math.round(-days)} days ago`);
      } else if (days < 3) {
        r = 0.15;
        exp.push(`Only ${Math.max(0, Math.round(days))} day(s) to respond`);
        gaps.push('Deadline too soon to respond well');
      } else if (days < 7) {
        r = 0.45;
        exp.push(`${Math.round(days)} days to respond (tight)`);
      } else if (days < 14) {
        r = 0.75;
        exp.push(`${Math.round(days)} days to respond`);
      } else {
        r = 1;
        exp.push(`${Math.round(days)} days to respond`);
      }
    } else if (['forecast', 'recompete_signal', 'grant_forecast', 'presolicitation', 'sources_sought', 'rfi'].includes(stage)) {
      r = 1;
      exp.push(`${STAGE_LABELS[stage]} stage — time to position before a solicitation`);
    } else {
      exp.push('No deadline published');
    }
    const months = durationMonths(opp);
    if (months && co.preferredDurationMonths) {
      const ratio = Math.min(months, co.preferredDurationMonths) / Math.max(months, co.preferredDurationMonths);
      if (ratio < 0.4) {
        r *= 0.8;
        exp.push(`Duration ~${Math.round(months)} months vs preferred ${co.preferredDurationMonths}`);
      }
    }
    add('timeline', r, exp);
  }

  // 8. Strategic / prime-sub fit
  {
    const exp: string[] = [];
    let r = 0.6;
    const pref = co.primeSubPreference;
    if (opp.opportunityClass === 'subcontract') {
      r = pref === 'sub' ? 1 : pref === 'prime' ? 0.35 : 0.7;
      exp.push(`Subcontract opportunity${pref ? ` (your preference: ${pref})` : ''}`);
    } else if (opp.opportunityClass === 'prime' || opp.opportunityClass === 'intelligence') {
      r = pref === 'prime' ? 1 : pref === 'sub' ? 0.5 : 0.75;
      exp.push(`Prime opportunity${pref ? ` (your preference: ${pref})` : ''}`);
    } else if (opp.opportunityClass === 'grant') {
      r = co.includeGrants ? 0.6 : 0;
      exp.push(co.includeGrants ? 'Grant/funding opportunity (grants enabled)' : 'Grants are disabled in your profile');
    }
    if (co.preferredTypes.includes(opp.stage)) {
      r += 0.2;
      exp.push(`${STAGE_LABELS[opp.stage as Stage] ?? opp.stage} is a preferred opportunity type`);
    }
    if (co.excludedTypes.includes(opp.stage)) {
      r = 0;
      exp.push(`${STAGE_LABELS[opp.stage as Stage] ?? opp.stage} is an excluded opportunity type`);
      gaps.push('Excluded opportunity type');
    }
    const lower = fullText.toLowerCase();
    const kw = co.keywords.filter((k) => findPhrase(lower, k) >= 0);
    if (kw.length) {
      r += Math.min(0.3, kw.length * 0.1);
      exp.push(`Keywords found: ${kw.slice(0, 5).join(', ')}`);
    }
    const neg = co.negativeKeywords.filter((k) => findPhrase(lower, k) >= 0);
    if (neg.length) {
      r -= Math.min(0.8, neg.length * 0.4);
      exp.push(`Negative keywords found: ${neg.slice(0, 5).join(', ')}`);
      gaps.push(`Contains negative keywords: ${neg.slice(0, 3).join(', ')}`);
    }
    add('strategy', r, exp);
  }

  const eligibility = evaluateEligibility(opp, co);
  for (const f of eligibility.flags) if (f.kind !== 'info') gaps.push(f.text);

  const totalMax = SCORE_COMPONENTS.reduce((s, c) => s + (w[c] ?? 0), 0) || 100;
  const points = comps.reduce((s, c) => s + c.points, 0);
  const fit = Math.round((points / totalMax) * 100);
  return { fit, components: comps, strengths, gaps: [...new Set(gaps)], matchedCapabilities: matched, eligibility, scopeTerms };
}
