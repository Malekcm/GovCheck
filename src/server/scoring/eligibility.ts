import { CLEARANCE_LABELS, CLEARANCE_RANK, ELIGIBILITY_RANK, SET_ASIDE_LABELS, type ClearanceLevel, type EligibilityStatus } from '../../shared/domain';
import { detectClearance, detectVehicle } from '../ai/rules';
import type { CompanyContext, EligibilityFlag, EligibilityResult, OppForScoring } from './types';

/** Set-aside code → certifications that satisfy it (any one). */
const SET_ASIDE_REQUIREMENTS: Record<string, { certs: string[]; label: string }> = {
  SBA: { certs: ['SMALL_BUSINESS'], label: 'small business' },
  SBP: { certs: ['SMALL_BUSINESS'], label: 'small business' },
  '8A': { certs: ['8A'], label: 'SBA 8(a) participant' },
  '8AN': { certs: ['8A'], label: 'SBA 8(a) participant (sole source)' },
  HZC: { certs: ['HUBZONE'], label: 'HUBZone-certified' },
  HZS: { certs: ['HUBZONE'], label: 'HUBZone-certified (sole source)' },
  SDVOSBC: { certs: ['SDVOSB'], label: 'SDVOSB' },
  SDVOSBS: { certs: ['SDVOSB'], label: 'SDVOSB (sole source)' },
  WOSB: { certs: ['WOSB', 'EDWOSB'], label: 'WOSB' },
  WOSBSS: { certs: ['WOSB', 'EDWOSB'], label: 'WOSB (sole source)' },
  EDWOSB: { certs: ['EDWOSB'], label: 'EDWOSB' },
  EDWOSBSS: { certs: ['EDWOSB'], label: 'EDWOSB (sole source)' },
  VSA: { certs: ['VOSB', 'SDVOSB'], label: 'veteran-owned small business' },
  VSS: { certs: ['VOSB', 'SDVOSB'], label: 'veteran-owned small business (sole source)' },
};

function worst(a: EligibilityStatus, b: EligibilityStatus): EligibilityStatus {
  return ELIGIBILITY_RANK[a] >= ELIGIBILITY_RANK[b] ? a : b;
}

function certStatus(co: CompanyContext, cert: string): 'held' | 'not_held' | 'pending' | 'unknown' {
  if (cert === 'SMALL_BUSINESS') {
    const s = co.certs.SMALL_BUSINESS;
    if (s && s !== 'unknown') return s;
    if (co.businessSize === 'small') return 'held';
    if (co.businessSize === 'other_than_small') return 'not_held';
    return 'unknown';
  }
  return co.certs[cert] ?? 'unknown';
}

/**
 * Hard eligibility signals. These are reported separately from the fit score.
 * We only say "Ineligible" when an OFFICIAL restriction conflicts with something the
 * user explicitly confirmed. Ambiguous or text-derived evidence yields "Unclear" or
 * "Likely ineligible" with an explanation of what to verify.
 */
export function evaluateEligibility(opp: OppForScoring, co: CompanyContext): EligibilityResult {
  const flags: EligibilityFlag[] = [];
  let status: EligibilityStatus = 'eligible';
  let anyUnknown = false;
  const isPrime = opp.opportunityClass === 'prime' || opp.opportunityClass === 'intelligence';

  // 1. Set-aside (official structured field)
  if (isPrime && opp.setAsideCode) {
    const req = SET_ASIDE_REQUIREMENTS[opp.setAsideCode];
    if (req) {
      const statuses = req.certs.map((c) => certStatus(co, c));
      const label = SET_ASIDE_LABELS[opp.setAsideCode] ?? opp.setAside ?? opp.setAsideCode;
      if (statuses.includes('held')) {
        flags.push({ severity: 'info', kind: 'info', text: `${label} set-aside — you have confirmed the qualifying status.`, rule: 'set_aside', evidenceProvenance: 'official' });
      } else if (statuses.every((s) => s === 'not_held')) {
        const sig = opp.isSignal ? 'likely_ineligible' : 'ineligible';
        status = worst(status, sig);
        flags.push({
          severity: 'critical',
          kind: 'hard_block',
          text: `${label} set-aside requires a ${req.label} prime. Your profile says you do not hold this status. Teaming as a subcontractor to an eligible prime may still be possible.`,
          rule: 'set_aside',
          evidenceProvenance: 'official',
        });
      } else {
        status = worst(status, 'unclear');
        anyUnknown = true;
        flags.push({
          severity: 'warning',
          kind: 'verify',
          text: `${label} set-aside — confirm whether you qualify as a ${req.label}${opp.setAsideCode.startsWith('SB') && co.primaryNaics !== opp.naics ? ` under the NAICS ${opp.naics ?? ''} size standard` : ''}.`,
          rule: 'set_aside',
          evidenceProvenance: 'official',
        });
      }
    } else if (opp.setAsideCode === 'LAS') {
      status = worst(status, 'unclear');
      flags.push({ severity: 'warning', kind: 'verify', text: 'Local Area Set-Aside — verify you reside or primarily do business in the designated area.', rule: 'set_aside', evidenceProvenance: 'official' });
    }
  }

  // 2. Security clearance (text-derived)
  const clearanceReq = opp.requirements.find((r) => r.category === 'clearance' || r.category === 'security_clearance');
  const detected = detectClearance(`${opp.title}\n${opp.text}`) ?? (clearanceReq ? detectClearance(clearanceReq.text + ' ' + (clearanceReq.quote ?? '')) : null);
  if (detected && detected.level !== 'none') {
    const companyMax = co.clearances.reduce<ClearanceLevel>((m, c) => (CLEARANCE_RANK[c] > CLEARANCE_RANK[m] ? c : m), 'none');
    const needed = CLEARANCE_LABELS[detected.level];
    if (!co.clearances.length) {
      status = worst(status, 'unclear');
      anyUnknown = true;
      flags.push({ severity: 'warning', kind: 'verify', text: `Text references a ${needed} clearance requirement. Add your clearance levels to the profile to evaluate this. Evidence: “${detected.quote}”`, rule: 'clearance', evidenceProvenance: 'derived' });
    } else if (CLEARANCE_RANK[companyMax] < CLEARANCE_RANK[detected.level]) {
      status = worst(status, detected.level === 'public_trust' ? 'unclear' : 'likely_ineligible');
      flags.push({
        severity: detected.level === 'public_trust' ? 'warning' : 'critical',
        kind: detected.level === 'public_trust' ? 'verify' : 'hard_block',
        text: `Requires ${needed} clearance (detected in text); your profile lists ${CLEARANCE_LABELS[companyMax]}. Evidence: “${detected.quote}”`,
        rule: 'clearance',
        evidenceProvenance: 'derived',
      });
    }
    if (detected.facility && !co.facilityClearance) {
      flags.push({ severity: 'warning', kind: 'verify', text: 'A facility clearance (FCL / DD-254) appears to be referenced — confirm your facility clearance status.', rule: 'facility_clearance', evidenceProvenance: 'derived' });
      status = worst(status, 'unclear');
    }
  }

  // 3. Contract vehicle
  const vehicleText = opp.contractVehicle ?? detectVehicle(`${opp.title}\n${opp.text}`)?.name ?? null;
  if (vehicleText && isPrime) {
    const holds = co.vehicles.some((v) => v.toLowerCase().includes(vehicleText.toLowerCase().split(' ')[0]) || vehicleText.toLowerCase().includes(v.toLowerCase()));
    if (!holds) {
      status = worst(status, opp.contractVehicle ? 'likely_ineligible' : 'unclear');
      flags.push({
        severity: opp.contractVehicle ? 'critical' : 'warning',
        kind: opp.contractVehicle ? 'hard_block' : 'verify',
        text: `Appears to be ordered under ${vehicleText}; your profile does not list this vehicle. Only vehicle holders can bid as prime.`,
        rule: 'vehicle',
        evidenceProvenance: opp.contractVehicle ? 'official' : 'derived',
      });
    }
  }

  // 4. SAM registration (prime federal awards require an active registration)
  if (isPrime && !opp.isSignal && (opp.stage === 'solicitation' || opp.stage === 'combined_synopsis')) {
    if (co.samStatus === 'inactive' || co.samStatus === 'not_registered') {
      status = worst(status, 'likely_ineligible');
      flags.push({ severity: 'critical', kind: 'hard_block', text: 'Federal prime awards require an active SAM.gov registration; your profile says it is not active.', rule: 'sam_registration', evidenceProvenance: 'user_entered' });
    } else if (!co.samStatus || co.samStatus === 'unknown') {
      anyUnknown = true;
    }
  }

  // 5. Grants applicant eligibility
  if (opp.opportunityClass === 'grant' && opp.eligibility.length) {
    const forProfit = opp.eligibility.some((e) => /for[\s-]profit|small business/i.test(e));
    const unrestricted = opp.eligibility.some((e) => /unrestricted/i.test(e));
    const others = opp.eligibility.some((e) => /others?\s*\(see/i.test(e));
    if (!forProfit && !unrestricted) {
      status = worst(status, others ? 'unclear' : 'likely_ineligible');
      flags.push({
        severity: others ? 'warning' : 'critical',
        kind: others ? 'verify' : 'hard_block',
        text: `Eligible applicants: ${opp.eligibility.slice(0, 4).join('; ')}${opp.eligibility.length > 4 ? '…' : ''}. For-profit businesses are not clearly eligible${others ? ' — check the eligibility notes' : ''}.`,
        rule: 'grant_applicant_type',
        evidenceProvenance: 'official',
      });
    }
  }

  // 6. Subcontract preferences (informational — primes may prefer certain small business types)
  if (opp.opportunityClass === 'subcontract' && opp.eligibility.length) {
    flags.push({ severity: 'info', kind: 'info', text: `Prime is soliciting: ${opp.eligibility.slice(0, 5).join('; ')}${opp.eligibility.length > 5 ? '…' : ''}.`, rule: 'subcontract_preferences', evidenceProvenance: 'official' });
  }

  if (status === 'eligible' && (anyUnknown || !co.configured)) status = 'likely_eligible';
  // Pre-solicitation records: the acquisition strategy / set-aside is not final yet.
  if (status === 'eligible' && ['forecast', 'recompete_signal', 'grant_forecast', 'sources_sought', 'rfi', 'presolicitation'].includes(opp.stage)) {
    status = 'likely_eligible';
    if (!opp.setAsideCode) flags.push({ severity: 'info', kind: 'info', text: 'Set-aside / acquisition strategy is not final at this stage — re-check when the solicitation is released.', rule: 'pre_solicitation', evidenceProvenance: 'derived' });
  }
  if (status === 'eligible' && !opp.setAsideCode && isPrime && !flags.some((f) => f.kind !== 'info')) status = co.samStatus === 'active' ? 'eligible' : 'likely_eligible';
  return { status, flags };
}
