-- =====================================================================
-- Government Opportunity Intelligence Engine — core schema
-- Portable across Supabase/PostgreSQL 15+ and embedded PGlite.
--
-- Design principles:
--   * Raw source data is never discarded (source_records + versions).
--   * Canonical OpportunityProfiles aggregate many source records.
--   * Every normalized value carries provenance (opportunity_field_values).
--   * User-entered data lives in separate tables that sync never writes to.
--   * Nothing is deleted on refresh; disappearance is recorded as state.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Company profile
-- ---------------------------------------------------------------------
CREATE TABLE company_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text,
  website                    text,
  uei                        text,
  cage                       text,
  business_size              text,           -- small | other_than_small | unknown
  sam_registration_status    text,           -- active | inactive | pending | not_registered | unknown
  sam_registration_expires   date,
  primary_naics              text,
  security_clearances        text[] NOT NULL DEFAULT '{}',  -- personnel clearance levels held (user confirmed)
  facility_clearance         text,           -- none | confidential | secret | top_secret | unknown
  geographic_service_area    text[] NOT NULL DEFAULT '{}',
  remote_capable             boolean,
  onsite_capable             boolean,
  travel_willingness         text,           -- none | limited | regional | national
  prime_sub_preference       text,           -- prime | sub | either
  min_contract_value         numeric,
  preferred_max_value        numeric,
  max_realistic_value        numeric,
  preferred_duration_months  integer,
  team_capacity              integer,
  preferred_agencies         text[] NOT NULL DEFAULT '{}',
  excluded_agencies          text[] NOT NULL DEFAULT '{}',
  preferred_locations        text[] NOT NULL DEFAULT '{}',
  excluded_locations         text[] NOT NULL DEFAULT '{}',
  preferred_opportunity_types text[] NOT NULL DEFAULT '{}',
  excluded_opportunity_types text[] NOT NULL DEFAULT '{}',
  keywords                   text[] NOT NULL DEFAULT '{}',
  negative_keywords          text[] NOT NULL DEFAULT '{}',
  include_grants             boolean NOT NULL DEFAULT false,
  scoring_weights            jsonb,
  onboarding_step            integer NOT NULL DEFAULT 0,
  onboarding_completed_at    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capabilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES capabilities(id) ON DELETE SET NULL,
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  category     text NOT NULL,
  keywords     text[] NOT NULL DEFAULT '{}',   -- match terms (synonyms) used by discovery & scoring
  description  text,
  is_custom    boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_capabilities (
  company_id        uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  capability_id     uuid NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'confirmed',  -- confirmed | suggested | rejected
  strength          integer CHECK (strength BETWEEN 1 AND 5),
  years_experience  numeric,
  notes             text,
  technologies      text[] NOT NULL DEFAULT '{}',
  staff_qualifications text,
  evidence          text,
  suggested_reason  text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, capability_id)
);

CREATE TABLE company_naics (
  company_id   uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  code         text NOT NULL,
  description  text,
  is_primary   boolean NOT NULL DEFAULT false,
  size_standard_met boolean,
  PRIMARY KEY (company_id, code)
);

CREATE TABLE company_psc (
  company_id   uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  code         text NOT NULL,
  description  text,
  PRIMARY KEY (company_id, code)
);

-- Certifications are only ever set by the user. status = held means user-confirmed.
CREATE TABLE company_certifications (
  company_id       uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  cert_type        text NOT NULL,       -- SMALL_BUSINESS | 8A | HUBZONE | SDVOSB | VOSB | WOSB | EDWOSB | SDB | OTHER:<name>
  status           text NOT NULL,       -- held | not_held | pending | unknown
  confirmed_at     timestamptz,
  expiration_date  date,
  notes            text,
  PRIMARY KEY (company_id, cert_type)
);

CREATE TABLE company_contract_vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  name             text NOT NULL,
  vehicle_type     text,               -- GWAC | IDIQ | BPA | GSA_SCHEDULE | OTHER
  contract_number  text,
  role             text,               -- prime | sub
  expiration_date  date,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_past_performance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
  client             text,
  agency             text,
  is_government      boolean,
  project_name       text NOT NULL,
  start_date         date,
  end_date           date,
  dollar_value       numeric,
  role               text,             -- prime | sub | commercial
  naics              text[] NOT NULL DEFAULT '{}',
  psc                text[] NOT NULL DEFAULT '{}',
  capability_ids     uuid[] NOT NULL DEFAULT '{}',
  technologies       text[] NOT NULL DEFAULT '{}',
  description        text,
  outcomes           text,
  contract_number    text,
  reference_name     text,
  reference_contact  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Sources, sync runs and raw records
-- ---------------------------------------------------------------------
CREATE TABLE source_connectors (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  source_type           text NOT NULL,     -- federal_opportunities | federal_awards | spending | forecast | subcontract | grants | feed | manual
  base_url              text,
  access_method         text NOT NULL,     -- api | bulk | feed | scraper | manual
  enabled               boolean NOT NULL DEFAULT true,
  auth_required         boolean NOT NULL DEFAULT false,
  auth_env_var          text,
  priority              integer NOT NULL DEFAULT 50,   -- source precedence: lower = more authoritative
  schedule_minutes      integer,
  config                jsonb NOT NULL DEFAULT '{}',
  cursor                jsonb NOT NULL DEFAULT '{}',
  health                text NOT NULL DEFAULT 'unknown', -- healthy | degraded | error | not_configured | disabled | unknown
  health_message        text,
  last_attempted_at     timestamptz,
  last_success_at       timestamptz,
  last_run_id           uuid,
  next_run_at           timestamptz,
  records_retrieved_total bigint NOT NULL DEFAULT 0,
  is_custom             boolean NOT NULL DEFAULT false,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id       text NOT NULL REFERENCES source_connectors(id),
  mode               text NOT NULL,      -- incremental | reconcile | by_identifier | enrich | derive
  status             text NOT NULL,      -- queued | running | partial_success | success | failed | skipped
  triggered_by       text NOT NULL DEFAULT 'manual',  -- manual | schedule | cron | opportunity_refresh | cli
  params             jsonb NOT NULL DEFAULT '{}',
  started_at         timestamptz,
  finished_at        timestamptz,
  duration_ms        integer,
  records_retrieved  integer NOT NULL DEFAULT 0,
  records_created    integer NOT NULL DEFAULT 0,
  records_updated    integer NOT NULL DEFAULT 0,
  records_unchanged  integer NOT NULL DEFAULT 0,
  records_failed     integer NOT NULL DEFAULT 0,
  opportunities_created integer NOT NULL DEFAULT 0,
  opportunities_updated integer NOT NULL DEFAULT 0,
  api_requests       integer NOT NULL DEFAULT 0,
  cursor_before      jsonb,
  cursor_after       jsonb,
  message            text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_runs_connector_idx ON sync_runs (connector_id, created_at DESC);

CREATE TABLE sync_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id   uuid REFERENCES sync_runs(id) ON DELETE CASCADE,
  connector_id  text,
  step          text NOT NULL,     -- fetch | store | normalize | resolve | link | enrich | score | document | ai
  record_ref    text,
  message       text NOT NULL,
  detail        jsonb,
  retryable     boolean NOT NULL DEFAULT false,
  retry_count   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_errors_run_idx ON sync_errors (sync_run_id);

-- Daily API request accounting (SAM.gov keys can be limited to 10 requests/day).
CREATE TABLE api_usage (
  connector_id  text NOT NULL,
  usage_date    date NOT NULL,
  requests      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (connector_id, usage_date)
);

CREATE TABLE source_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id      text NOT NULL REFERENCES source_connectors(id),
  source_record_id  text NOT NULL,
  record_kind       text NOT NULL,      -- opportunity | award | forecast | subcontract | grant | spending_award
  raw               jsonb,
  raw_text          text,
  content_hash      text NOT NULL,
  parser_version    text NOT NULL,
  normalized        jsonb,
  normalized_hash   text,
  normalized_at     timestamptz,
  retrieved_at      timestamptz NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_changed_at   timestamptz NOT NULL DEFAULT now(),
  seen_status       text NOT NULL DEFAULT 'active',   -- active | not_seen | archived | removed_from_source
  version_count     integer NOT NULL DEFAULT 1,
  source_url        text,
  UNIQUE (connector_id, source_record_id)
);
CREATE INDEX source_records_kind_idx ON source_records (record_kind);

-- Every distinct version of a raw record is kept forever.
CREATE TABLE source_record_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  content_hash     text NOT NULL,
  raw              jsonb,
  raw_text         text,
  parser_version   text NOT NULL,
  retrieved_at     timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_record_id, content_hash)
);

-- ---------------------------------------------------------------------
-- Reference entities: agencies, offices, vendors, contacts
-- ---------------------------------------------------------------------
CREATE TABLE agencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES agencies(id),
  level       text NOT NULL,          -- department | subtier
  name        text NOT NULL,
  name_key    text NOT NULL,
  code        text,
  abbreviation text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (level, name_key)
);

CREATE TABLE agency_offices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid REFERENCES agencies(id),
  name        text NOT NULL,
  name_key    text NOT NULL,
  code        text,
  city        text,
  state       text,
  zip         text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, name_key)
);

CREATE TABLE vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  name_key      text NOT NULL,
  uei           text UNIQUE,
  cage          text,
  parent_uei    text,
  parent_name   text,
  business_types text[] NOT NULL DEFAULT '{}',
  city          text,
  state         text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_name_idx ON vendors (name_key);

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_key   text NOT NULL UNIQUE,     -- lower(email) or normalized name+org
  full_name     text,
  title         text,
  email         text,
  phone         text,
  fax           text,
  organization  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Canonical opportunity profiles
-- ---------------------------------------------------------------------
CREATE TABLE opportunities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  opportunity_class    text NOT NULL,     -- prime | subcontract | grant | intelligence
  stage                text NOT NULL,     -- forecast | sources_sought | rfi | presolicitation | solicitation | combined_synopsis | special_notice | award | recompete_signal | grant_forecast | grant_posted | subcontract | other
  notice_type          text,              -- raw official notice type label
  status               text NOT NULL,     -- active | closed | archived | awarded | cancelled | forecast | signal | unknown
  is_signal            boolean NOT NULL DEFAULT false,   -- inferred intelligence, NOT an active solicitation
  solicitation_number  text,
  primary_notice_id    text,
  agency_id            uuid REFERENCES agencies(id),
  subagency_id         uuid REFERENCES agencies(id),
  office_id            uuid REFERENCES agency_offices(id),
  department_name      text,
  subtier_name         text,
  office_name          text,
  naics_code           text,
  naics_codes          text[] NOT NULL DEFAULT '{}',
  psc_code             text,
  set_aside_code       text,
  set_aside            text,
  contract_vehicle     text,
  pricing_type         text,
  competition_type     text,
  posted_at            timestamptz,
  source_updated_at    timestamptz,
  response_deadline    timestamptz,
  archive_date         timestamptz,
  performance_start    date,
  performance_end      date,
  value_low            numeric,
  value_high           numeric,
  value_provenance     text,              -- official | derived | estimated | ai_extracted | user_entered | unknown
  value_label          text,              -- human description of what value_low/high represent
  place_city           text,
  place_state          text,
  place_zip            text,
  place_country        text,
  description          text,              -- sanitized plain text / safe html
  summary              text,
  primary_url          text,
  has_documents        boolean NOT NULL DEFAULT false,
  has_incumbent        boolean NOT NULL DEFAULT false,
  incumbent_name       text,
  recompete_signal     boolean NOT NULL DEFAULT false,
  source_count         integer NOT NULL DEFAULT 0,
  connector_ids        text[] NOT NULL DEFAULT '{}',
  data_completeness    integer,
  completeness_detail  jsonb,
  discovery_reasons    jsonb NOT NULL DEFAULT '[]',
  fit_score            integer,
  preference_score     integer,
  eligibility_status   text,             -- eligible | likely_eligible | unclear | likely_ineligible | ineligible
  scored_at            timestamptz,
  canonical_hash       text,
  merged_into_id       uuid REFERENCES opportunities(id),
  seen_status          text NOT NULL DEFAULT 'active',
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_changed_at      timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  search_vector        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(solicitation_number, '') || ' ' || coalesce(primary_notice_id, '') || ' ' ||
                                     coalesce(department_name, '') || ' ' || coalesce(subtier_name, '') || ' ' ||
                                     coalesce(office_name, '') || ' ' || coalesce(incumbent_name, '') || ' ' ||
                                     coalesce(naics_code, '') || ' ' || coalesce(psc_code, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(summary, '') || ' ' || coalesce(description, ''), 200000)), 'C')
  ) STORED
);
CREATE INDEX opportunities_search_idx ON opportunities USING GIN (search_vector);
CREATE INDEX opportunities_stage_idx ON opportunities (stage);
CREATE INDEX opportunities_class_idx ON opportunities (opportunity_class);
CREATE INDEX opportunities_deadline_idx ON opportunities (response_deadline);
CREATE INDEX opportunities_fit_idx ON opportunities (fit_score DESC NULLS LAST);
CREATE INDEX opportunities_pref_idx ON opportunities (preference_score DESC NULLS LAST);
CREATE INDEX opportunities_changed_idx ON opportunities (last_changed_at DESC);
CREATE INDEX opportunities_solnum_idx ON opportunities (solicitation_number);
CREATE INDEX opportunities_naics_idx ON opportunities (naics_code);
CREATE INDEX opportunities_agency_idx ON opportunities (agency_id);
CREATE INDEX opportunities_office_idx ON opportunities (office_id);
CREATE INDEX opportunities_merged_idx ON opportunities (merged_into_id);

CREATE TABLE opportunity_identifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  id_type           text NOT NULL,   -- notice_id | solicitation_number | piid | award_number | idv_piid | forecast_id | grant_number | grant_id | subnet_id | usaspending_award_id | source_listing_id
  value             text NOT NULL,
  normalized_value  text NOT NULL,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, id_type, normalized_value)
);
CREATE INDEX opportunity_identifiers_lookup_idx ON opportunity_identifiers (id_type, normalized_value);

-- Which source records contributed to which profile, and how they were linked.
CREATE TABLE opportunity_sources (
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_record_id  uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  role              text NOT NULL DEFAULT 'primary',   -- primary | contributing | award | historical
  link_method       text NOT NULL,                     -- created | exact | probabilistic | manual | merge
  confidence        numeric NOT NULL DEFAULT 1,
  evidence          jsonb NOT NULL DEFAULT '[]',
  linked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, source_record_id)
);
CREATE INDEX opportunity_sources_record_idx ON opportunity_sources (source_record_id);

-- Field-level provenance. Every value from every source is kept; one is preferred.
CREATE TABLE opportunity_field_values (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field             text NOT NULL,
  value             jsonb,
  value_text        text,
  provenance        text NOT NULL,   -- official | derived | estimated | ai_extracted | user_entered | unknown
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  basis             text,
  confidence        text,            -- high | medium | low
  observed_at       timestamptz NOT NULL DEFAULT now(),
  is_current        boolean NOT NULL DEFAULT true,    -- latest value from this source for this field
  is_preferred      boolean NOT NULL DEFAULT false,   -- chosen canonical value
  superseded_at     timestamptz
);
CREATE INDEX field_values_opp_idx ON opportunity_field_values (opportunity_id, field);

CREATE TABLE opportunity_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  canonical_hash  text NOT NULL,
  snapshot        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_snapshots_opp_idx ON opportunity_snapshots (opportunity_id, created_at DESC);

CREATE TABLE opportunity_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  event_type        text NOT NULL,   -- NEW_OPPORTUNITY | NEW_SOURCE | STATUS_CHANGED | DEADLINE_CHANGED | VALUE_CHANGED | CONTACT_CHANGED | NEW_DOCUMENT | DOCUMENT_UPDATED | AMENDMENT | AWARD_POSTED | FORECAST_LINKED | INCUMBENT_IDENTIFIED | RECOMPETE_SIGNAL | RELATIONSHIP_FOUND | STAGE_CHANGED | FIELD_CHANGED | REMOVED_FROM_SOURCE | MERGED | LIFECYCLE
  is_lifecycle      boolean NOT NULL DEFAULT false,  -- shown on procurement timeline
  lifecycle_stage   text,
  title             text NOT NULL,
  field             text,
  old_value         jsonb,
  new_value         jsonb,
  detail            jsonb NOT NULL DEFAULT '{}',
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  occurred_at       timestamptz,     -- when it happened in the real world (e.g. notice posted date)
  detected_at       timestamptz NOT NULL DEFAULT now(),
  dedupe_key        text,
  UNIQUE (opportunity_id, dedupe_key)
);
CREATE INDEX opportunity_events_recent_idx ON opportunity_events (detected_at DESC);
CREATE INDEX opportunity_events_opp_idx ON opportunity_events (opportunity_id, occurred_at);

CREATE TABLE opportunity_relationships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  to_opportunity_id   uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  relationship_type  text NOT NULL,   -- possible_same_procurement | possible_duplicate | related | possible_predecessor | predecessor | successor | forecast_of | merged
  status             text NOT NULL DEFAULT 'suggested',   -- suggested | confirmed | rejected
  confidence         numeric,
  method             text NOT NULL,   -- exact | probabilistic | semantic | manual
  evidence           jsonb NOT NULL DEFAULT '[]',
  created_by         text NOT NULL DEFAULT 'system',      -- system | user
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  UNIQUE (from_opportunity_id, to_opportunity_id, relationship_type)
);
CREATE INDEX opp_rel_to_idx ON opportunity_relationships (to_opportunity_id);

CREATE TABLE opportunity_contacts (
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role              text NOT NULL,      -- contracting_officer | contract_specialist | primary | secondary | program | small_business | prime_contact | grants_contact | other
  provenance        text NOT NULL DEFAULT 'official',
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, contact_id, role)
);

CREATE TABLE opportunity_locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'place_of_performance',  -- place_of_performance | office
  street            text,
  city              text,
  state             text,
  zip               text,
  country           text,
  provenance        text NOT NULL DEFAULT 'official',
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  location_key      text NOT NULL,
  UNIQUE (opportunity_id, kind, location_key)
);

CREATE TABLE opportunity_dates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind              text NOT NULL,   -- posted | updated | questions_due | response_due | expected_award | expected_solicitation | performance_start | performance_end | potential_end | archive | recompete_window_start | recompete_window_end | forecast_award_fy
  date_value        timestamptz,
  date_text         text,            -- e.g. "FY2027 Q2" when only partial
  provenance        text NOT NULL,
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  basis             text,
  is_current        boolean NOT NULL DEFAULT true,
  observed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_dates_opp_idx ON opportunity_dates (opportunity_id, kind);

CREATE TABLE opportunity_financials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind              text NOT NULL,   -- forecast_estimate | official_estimate | ceiling | award_value | obligated | potential_value | base_and_exercised | historical_incumbent | comparable_range | estimated_likely | estimated_annual | grant_ceiling | grant_floor | grant_total_funding | subcontract_value
  amount_low        numeric,
  amount_high       numeric,
  provenance        text NOT NULL,
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  award_id          uuid,
  label             text,
  basis             text,
  confidence        text,
  is_current        boolean NOT NULL DEFAULT true,
  observed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_financials_opp_idx ON opportunity_financials (opportunity_id);

CREATE TABLE opportunity_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  connector_id      text,
  source_record_id  uuid REFERENCES source_records(id) ON DELETE SET NULL,
  url               text NOT NULL,
  filename          text,
  doc_type          text,            -- RFP | RFQ | RFI | SOURCES_SOUGHT | SOW | PWS | SOO | ATTACHMENT | PRICING | AMENDMENT | QA | FORM | PAST_PERFORMANCE | ANNOUNCEMENT | OTHER
  mime_type         text,
  size_bytes        bigint,
  posted_at         timestamptz,
  version           integer NOT NULL DEFAULT 1,
  content_hash      text,
  previous_hash     text,
  changed_since_previous boolean NOT NULL DEFAULT false,
  retrieval_status  text NOT NULL DEFAULT 'not_downloaded', -- not_downloaded | downloaded | failed | skipped | too_large
  text_status       text NOT NULL DEFAULT 'pending',        -- pending | extracted | failed | unsupported | ocr_needed
  text_content      text,
  page_count        integer,
  error_message     text,
  retrieved_at      timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, url)
);

CREATE TABLE opportunity_requirements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  category          text NOT NULL,   -- objective | task | workstream | deliverable | technology | system | labor_category | staffing | key_personnel | certification | clearance | travel | location | performance_standard | reporting | compliance | submission | evaluation_factor | mandatory | page_limit | question_deadline | risk | missing_information | contract_type | contract_vehicle
  text              text NOT NULL,
  provenance        text NOT NULL,   -- official | derived | ai_extracted | user_entered
  document_id       uuid REFERENCES opportunity_documents(id) ON DELETE SET NULL,
  page              integer,
  section           text,
  evidence_quote    text,
  analysis_id       uuid,
  content_hash      text,            -- the hash of the content this was derived from
  is_current        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_requirements_opp_idx ON opportunity_requirements (opportunity_id, category);

-- ---------------------------------------------------------------------
-- Awards (SAM Contract Awards + USAspending), linked to profiles
-- ---------------------------------------------------------------------
CREATE TABLE awards (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_key              text NOT NULL UNIQUE,     -- stable: <source>:<id>
  connector_id           text NOT NULL,
  source_record_id       uuid REFERENCES source_records(id) ON DELETE SET NULL,
  piid                   text,
  piid_key               text,
  modification_number    text,
  referenced_idv_piid    text,
  solicitation_id        text,
  solicitation_key       text,
  usaspending_id         text,
  award_type             text,
  idv_type               text,
  description            text,
  vendor_id              uuid REFERENCES vendors(id),
  awardee_name           text,
  awardee_uei            text,
  awardee_cage           text,
  dollars_obligated      numeric,
  total_obligated        numeric,
  base_and_all_options   numeric,
  base_and_exercised     numeric,
  total_outlays          numeric,
  date_signed            date,
  pop_start              date,
  pop_current_end        date,
  pop_potential_end      date,
  department_name        text,
  subtier_name           text,
  office_name            text,
  office_code            text,
  funding_agency         text,
  funding_office         text,
  naics_code             text,
  psc_code               text,
  pricing_type           text,
  extent_competed        text,
  set_aside              text,
  number_of_offers       integer,
  business_size          text,
  place_state            text,
  place_city             text,
  subaward_count         integer,
  subaward_amount        numeric,
  last_modified          timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX awards_piid_idx ON awards (piid_key);
CREATE INDEX awards_sol_idx ON awards (solicitation_key);
CREATE INDEX awards_vendor_idx ON awards (vendor_id);
CREATE INDEX awards_end_idx ON awards (pop_current_end);
CREATE INDEX awards_naics_idx ON awards (naics_code);
CREATE INDEX awards_office_idx ON awards (office_name);

CREATE TABLE opportunity_awards (
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  award_id        uuid NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
  relationship    text NOT NULL,     -- award_of | incumbent | possible_incumbent | predecessor | possible_predecessor | comparable | task_order | modification
  confidence      text NOT NULL,     -- high | medium | low
  confidence_score numeric,
  method          text NOT NULL,     -- exact | probabilistic | manual
  evidence        jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'active',  -- active | rejected (user)
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, award_id, relationship)
);

CREATE TABLE opportunity_vendors (
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  vendor_id       uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  role            text NOT NULL,     -- confirmed_incumbent | possible_incumbent | awardee | prime_contractor
  confidence      text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, vendor_id, role)
);

-- ---------------------------------------------------------------------
-- AI analyses (cached by content hash)
-- ---------------------------------------------------------------------
CREATE TABLE ai_analyses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash   text NOT NULL,
  analysis_type  text NOT NULL,     -- requirements_extraction | summary | scope_classification | feedback_interpretation
  provider       text NOT NULL,
  model          text NOT NULL,
  prompt_version text NOT NULL,
  status         text NOT NULL,     -- success | failed | refused
  output         jsonb,
  error_message  text,
  input_tokens   integer,
  output_tokens  integer,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_hash, analysis_type, model, prompt_version)
);

-- ---------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------
CREATE TABLE match_scores (
  opportunity_id     uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  company_id         uuid REFERENCES company_profiles(id) ON DELETE CASCADE,
  fit_score          integer NOT NULL,
  preference_score   integer,
  learned_component  numeric,
  blend_alpha        numeric,
  eligibility_status text NOT NULL,
  model_version      integer,
  weights            jsonb NOT NULL,
  inputs_hash        text,
  computed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match_score_components (
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  component       text NOT NULL,     -- capability | scope | past_performance | alignment | value | location | timeline | strategy
  weight          numeric NOT NULL,
  points          numeric NOT NULL,
  max_points      numeric NOT NULL,
  ratio           numeric NOT NULL,
  explanation     jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (opportunity_id, component)
);

CREATE TABLE match_explanations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind            text NOT NULL,     -- strength | gap | hard_block | verify | matched_capability
  component       text,
  text            text NOT NULL,
  severity        text,              -- info | warning | critical
  detail          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX match_explanations_opp_idx ON match_explanations (opportunity_id);

CREATE TABLE score_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id   uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  fit_score        integer,
  preference_score integer,
  model_version    integer,
  reason           text,
  computed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX score_history_opp_idx ON score_history (opportunity_id, computed_at DESC);

-- ---------------------------------------------------------------------
-- User decisions, feedback and notes — never written by sync
-- ---------------------------------------------------------------------
CREATE TABLE user_feedback_reasons (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  polarity    text NOT NULL,     -- positive | negative
  feature_groups text[] NOT NULL DEFAULT '{}',   -- which preference features this reason informs
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE user_opportunity_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  decision        text NOT NULL,   -- pursue | interested | watch | maybe | pass | not_relevant
  reasons         text[] NOT NULL DEFAULT '{}',
  explanation     text,
  is_current      boolean NOT NULL DEFAULT true,
  feature_snapshot jsonb,          -- features at decision time (for reproducible learning)
  decided_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_opp_idx ON user_opportunity_decisions (opportunity_id, decided_at DESC);
CREATE INDEX decisions_current_idx ON user_opportunity_decisions (is_current);

CREATE TABLE user_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX user_notes_opp_idx ON user_notes (opportunity_id);

CREATE TABLE user_tags (
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  tag             text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, tag)
);

CREATE TABLE user_field_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field           text NOT NULL,
  value           jsonb,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, field)
);

CREATE TABLE opportunity_views (
  opportunity_id  uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at  timestamptz NOT NULL DEFAULT now(),
  view_count      integer NOT NULL DEFAULT 1
);

CREATE TABLE watchlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE,
  name        text NOT NULL,
  description text,
  filters     jsonb NOT NULL DEFAULT '{}',
  sort        text,
  is_system   boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Merge decisions are journaled so every merge can be undone.
CREATE TABLE merge_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action            text NOT NULL,   -- merge | keep_separate | link_related | mark_predecessor | mark_successor | undo_merge
  primary_id        uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  secondary_id      uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  relationship_id   uuid REFERENCES opportunity_relationships(id) ON DELETE SET NULL,
  moved             jsonb NOT NULL DEFAULT '{}',   -- what was moved, for undo
  note              text,
  created_by        text NOT NULL DEFAULT 'user',
  created_at        timestamptz NOT NULL DEFAULT now(),
  undone_at         timestamptz
);

-- ---------------------------------------------------------------------
-- Preference learning
-- ---------------------------------------------------------------------
CREATE TABLE preference_models (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version         integer NOT NULL UNIQUE,
  sample_count    integer NOT NULL,
  stage           text NOT NULL,      -- base_only | small | moderate | strong
  blend_alpha     numeric NOT NULL,
  bias            numeric NOT NULL DEFAULT 0,
  metrics         jsonb NOT NULL DEFAULT '{}',
  trigger         text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE preference_weights (
  model_id        uuid NOT NULL REFERENCES preference_models(id) ON DELETE CASCADE,
  feature         text NOT NULL,
  weight          numeric NOT NULL,
  support         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (model_id, feature)
);

-- ---------------------------------------------------------------------
-- Coverage / missed-opportunity signals
-- ---------------------------------------------------------------------
CREATE TABLE coverage_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type     text NOT NULL,   -- FORECAST_ONLY | SUBCONTRACT_ONLY | POSSIBLE_RECOMPETE | NO_SAM_MATCH | NO_AWARD_LINK | ORPHAN_AWARD | POSSIBLE_DUPLICATE | MISSING_DOCUMENTS | SOURCE_CONFLICT | STALE_RECORD | FORECAST_OVERDUE | SOURCES_SOUGHT_NO_FOLLOWUP | NO_FORECAST_LINK
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  award_id        uuid REFERENCES awards(id) ON DELETE CASCADE,
  signal_key      text NOT NULL UNIQUE,
  title           text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  severity        text NOT NULL DEFAULT 'info',   -- info | notice | important
  status          text NOT NULL DEFAULT 'open',   -- open | resolved | dismissed
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX coverage_signals_type_idx ON coverage_signals (signal_type, status);

-- ---------------------------------------------------------------------
-- Application state (last visit, settings)
-- ---------------------------------------------------------------------
CREATE TABLE app_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
