import type { AppConfig } from '../config';
import type { Db } from '../db';
import type { HttpClient } from '../lib/http';
import type { IdentifierType } from '../lib/ids';
import type { Logger } from '../lib/logger';
import type { OpportunityClass, Provenance, Stage } from '../../shared/domain';

export type RecordKind = 'opportunity' | 'award' | 'forecast' | 'subcontract' | 'grant';
export type AccessMethod = 'api' | 'bulk' | 'feed' | 'scraper' | 'manual';
export type SyncMode = 'incremental' | 'reconcile';

export interface ConnectorMeta {
  id: string;
  name: string;
  sourceType: 'federal_opportunities' | 'federal_awards' | 'spending' | 'forecast' | 'subcontract' | 'grants' | 'feed';
  baseUrl: string;
  accessMethod: AccessMethod;
  authRequired: boolean;
  authEnvVar?: string;
  /** Source precedence when values conflict (lower = more authoritative). */
  priority: number;
  /** Default incremental schedule in minutes (null = manual only). */
  defaultScheduleMinutes: number | null;
  /** Default reconciliation schedule in minutes (null = manual only). */
  reconcileScheduleMinutes?: number | null;
  description: string;
  supportsReconcile: boolean;
  supportsIdentifierFetch: IdentifierType[];
  /** Setup / limitation notes shown on the Sources page. */
  notes?: string;
}

/** A record exactly as retrieved from the source. Stored verbatim. */
export interface RawRecord {
  sourceRecordId: string;
  kind: RecordKind;
  raw: unknown;
  rawText?: string;
  retrievedAt: Date;
  sourceUrl?: string;
}

export interface FetchPage {
  records: RawRecord[];
  /** Cursor to persist after this page has been fully processed (enables resume). */
  cursor?: Record<string, unknown>;
  apiRequests?: number;
  note?: string;
  /**
   * A coverage problem the connector noticed (duplicate pages, fewer records than the source
   * reports, skipped sections). Any warning makes the run "partial_success" / health "degraded"
   * so a green sync icon never hides a coverage gap.
   */
  warning?: string;
}

/** Shared, per-day request budgets (e.g. SAM.gov personal keys: 10 requests/day). */
export interface RequestBudget {
  remaining(key: string): Promise<number>;
  consume(key: string, n?: number): Promise<void>;
}

export interface ConnectorContext {
  db: Db;
  http: HttpClient;
  config: AppConfig;
  log: Logger;
  budget: RequestBudget;
  /** Connector-specific settings from source_connectors.config (user-editable). */
  settings: Record<string, unknown>;
  /** Company targeting hints (NAICS, PSC) for sources that require a query focus. */
  focus: { naics: string[]; psc: string[]; keywords: string[]; includeGrants: boolean };
  /** Stop when this returns true (time limit / shutdown). */
  shouldStop: () => boolean;
  /** For parameterized runs (e.g. archived fiscal year import). */
  params: Record<string, unknown>;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'error' | 'not_configured';
  message: string;
}

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------
export interface NormalizedIdentifier {
  type: IdentifierType;
  value: string;
}

export interface NormalizedDate {
  kind: string; // posted | updated | questions_due | response_due | expected_award | expected_solicitation | performance_start | performance_end | potential_end | archive | forecast_award_fy
  value?: string | null; // ISO
  text?: string | null;
  provenance?: Provenance;
  basis?: string;
}

export interface NormalizedFinancial {
  kind: string;
  low?: number | null;
  high?: number | null;
  label?: string;
  basis?: string;
  provenance?: Provenance;
}

export interface NormalizedContact {
  role: string;
  fullName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  organization?: string | null;
}

export interface NormalizedDocument {
  url: string;
  filename?: string | null;
  docType?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  postedAt?: string | null;
  /** Requires the SAM api key appended (budgeted). */
  requiresSamKey?: boolean;
}

export interface NormalizedPlace {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface NormalizedAgency {
  department?: string | null;
  departmentCode?: string | null;
  subtier?: string | null;
  subtierCode?: string | null;
  office?: string | null;
  officeCode?: string | null;
  fullPath?: string | null;
}

export interface NormalizedAwardee {
  name?: string | null;
  uei?: string | null;
  cage?: string | null;
  parentUei?: string | null;
  parentName?: string | null;
  city?: string | null;
  state?: string | null;
  businessTypes?: string[];
}

export interface NormalizedAward {
  awardKey: string;
  piid?: string | null;
  modificationNumber?: string | null;
  referencedIdvPiid?: string | null;
  solicitationId?: string | null;
  usaspendingId?: string | null;
  awardType?: string | null;
  idvType?: string | null;
  description?: string | null;
  awardee: NormalizedAwardee;
  dollarsObligated?: number | null;
  totalObligated?: number | null;
  baseAndAllOptions?: number | null;
  baseAndExercised?: number | null;
  totalOutlays?: number | null;
  dateSigned?: string | null;
  popStart?: string | null;
  popCurrentEnd?: string | null;
  popPotentialEnd?: string | null;
  agency: NormalizedAgency;
  fundingAgency?: string | null;
  fundingOffice?: string | null;
  naics?: string | null;
  psc?: string | null;
  pricingType?: string | null;
  extentCompeted?: string | null;
  setAside?: string | null;
  numberOfOffers?: number | null;
  businessSize?: string | null;
  placeState?: string | null;
  placeCity?: string | null;
  subawardCount?: number | null;
  subawardAmount?: number | null;
  lastModified?: string | null;
}

export interface NormalizedOpportunity {
  opportunityClass: OpportunityClass;
  stage: Stage;
  /** How the stage was determined when not taken verbatim (e.g. RFI detected from title). */
  stageBasis?: string;
  /** Set when the status was derived (e.g. cancellation detected from the title) rather than reported. */
  statusBasis?: string;
  noticeType?: string | null;
  status: 'active' | 'closed' | 'archived' | 'awarded' | 'cancelled' | 'forecast' | 'signal' | 'unknown';
  title: string;
  /** Sanitized HTML or plain text. */
  description?: string | null;
  descriptionUrl?: string | null;
  identifiers: NormalizedIdentifier[];
  agency: NormalizedAgency;
  naics: string[];
  psc?: string | null;
  setAsideCode?: string | null;
  setAside?: string | null;
  contractVehicle?: string | null;
  pricingType?: string | null;
  competitionType?: string | null;
  dates: NormalizedDate[];
  financials: NormalizedFinancial[];
  place?: NormalizedPlace | null;
  officeAddress?: NormalizedPlace | null;
  contacts: NormalizedContact[];
  documents: NormalizedDocument[];
  links: { url: string; label: string }[];
  url?: string | null;
  /** Award information carried on an award notice. */
  award?: NormalizedAward | null;
  primeContractor?: { name: string; website?: string | null; division?: string | null } | null;
  eligibility?: string[];
  recompeteHint?: boolean;
  /** Additional useful fields not mapped to columns (kept for display). */
  extra: Record<string, unknown>;
}

export type NormalizedResult = { type: 'opportunity'; data: NormalizedOpportunity } | { type: 'award'; data: NormalizedAward } | null;

export interface SourceAdapter {
  meta: ConnectorMeta;
  parserVersion: string;
  isConfigured(config: AppConfig): { configured: boolean; reason?: string };
  testConnection(ctx: ConnectorContext): Promise<HealthResult>;
  /** Incremental fetch from the stored cursor. Yields pages; the cursor is persisted after each page. */
  fetchIncremental(ctx: ConnectorContext, cursor: Record<string, unknown>): AsyncGenerator<FetchPage>;
  /** Broader reconciliation pass (bulk files, full re-listing). */
  fetchReconcile?(ctx: ConnectorContext, cursor: Record<string, unknown>): AsyncGenerator<FetchPage>;
  /** Re-fetch a single record by identifier (used by "Refresh this opportunity"). */
  fetchByIdentifier?(ctx: ConnectorContext, idType: IdentifierType, value: string, hint?: Record<string, unknown>): Promise<RawRecord[]>;
  normalize(record: RawRecord): NormalizedResult;
}
