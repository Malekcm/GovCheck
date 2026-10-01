import type { ClearanceLevel, EligibilityStatus, ScoreComponent } from '../../shared/domain';

export interface CompanyCapability {
  id: string;
  slug: string;
  name: string;
  category: string;
  keywords: string[];
  strength: number; // 1-5 (defaults to 3)
  years: number | null;
  technologies: string[];
}

export interface PastProject {
  id: string;
  name: string;
  agency: string | null;
  client: string | null;
  value: number | null;
  role: string | null;
  naics: string[];
  psc: string[];
  text: string;
  endDate: string | null;
}

export interface CompanyContext {
  id: string | null;
  name: string | null;
  configured: boolean;
  capabilities: CompanyCapability[];
  naics: string[];
  primaryNaics: string | null;
  psc: string[];
  certs: Record<string, 'held' | 'not_held' | 'pending' | 'unknown'>;
  businessSize: string | null;
  samStatus: string | null;
  vehicles: string[];
  clearances: ClearanceLevel[];
  facilityClearance: string | null;
  pastPerformance: PastProject[];
  remoteCapable: boolean | null;
  onsiteCapable: boolean | null;
  travelWillingness: string | null;
  serviceArea: string[];
  preferredLocations: string[];
  excludedLocations: string[];
  primeSubPreference: string | null;
  minValue: number | null;
  preferredMaxValue: number | null;
  maxRealisticValue: number | null;
  preferredDurationMonths: number | null;
  teamCapacity: number | null;
  preferredAgencies: string[];
  excludedAgencies: string[];
  preferredTypes: string[];
  excludedTypes: string[];
  keywords: string[];
  negativeKeywords: string[];
  includeGrants: boolean;
  weights: Record<ScoreComponent, number>;
}

export interface OppForScoring {
  id: string;
  title: string;
  text: string; // description + requirements + document excerpts (plain text)
  stage: string;
  opportunityClass: string;
  isSignal: boolean;
  status: string;
  naics: string | null;
  naicsCodes: string[];
  psc: string | null;
  setAsideCode: string | null;
  setAside: string | null;
  department: string | null;
  subtier: string | null;
  office: string | null;
  valueLow: number | null;
  valueHigh: number | null;
  valueProvenance: string | null;
  valueLabel: string | null;
  placeState: string | null;
  placeCity: string | null;
  deadline: string | null;
  postedAt: string | null;
  performanceStart: string | null;
  performanceEnd: string | null;
  contractVehicle: string | null;
  eligibility: string[];
  /** Requirements extracted (derived or AI) — used for eligibility signals. */
  requirements: { category: string; text: string; provenance: string; quote?: string | null }[];
}

export interface ComponentResult {
  component: ScoreComponent;
  weight: number;
  points: number;
  max: number;
  ratio: number;
  explanation: string[];
}

export interface MatchedCapability {
  capabilityId: string;
  slug: string;
  name: string;
  category: string;
  strength: number;
  matchedTerm: string;
  inTitle: boolean;
  evidence: string;
}

export interface EligibilityFlag {
  severity: 'critical' | 'warning' | 'info';
  kind: 'hard_block' | 'verify' | 'info';
  text: string;
  rule: string;
  evidenceProvenance: string;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  flags: EligibilityFlag[];
}

export interface FitResult {
  fit: number;
  components: ComponentResult[];
  strengths: string[];
  gaps: string[];
  matchedCapabilities: MatchedCapability[];
  eligibility: EligibilityResult;
  scopeTerms: string[];
}
