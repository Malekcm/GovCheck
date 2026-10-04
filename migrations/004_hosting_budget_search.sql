-- =====================================================================
-- 004: shared hosting (Supabase), SAM request accounting, targeted
-- search history and user-editable capability search terms.
-- Additive only — no existing data is modified or removed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Per-request SAM.gov accounting. api_usage keeps the authoritative daily
-- total (enforced atomically); this log records WHY each request was spent
-- so administrators can see which categories used the budget.
-- ---------------------------------------------------------------------
CREATE TABLE api_request_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_key    text NOT NULL,              -- sam
  usage_date    date NOT NULL,
  category      text NOT NULL,              -- tracked | active_changes | stale_high_fit | new_match | targeted_search | manual_refresh | discovery | awards | documents | test | other
  connector_id  text,
  requests      integer NOT NULL DEFAULT 1,
  detail        jsonb NOT NULL DEFAULT '{}',
  requested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_log_day_idx ON api_request_log (budget_key, usage_date, category);

-- ---------------------------------------------------------------------
-- Targeted (user-initiated) SAM searches. Results are ingested through the
-- normal pipeline (source_records + versions); this table is the audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE targeted_searches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filters           jsonb NOT NULL,
  sam_params        jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL,           -- success | partial | failed
  requests_used     integer NOT NULL DEFAULT 0,
  requests_planned  integer NOT NULL DEFAULT 0,
  results_returned  integer NOT NULL DEFAULT 0,
  results_kept      integer NOT NULL DEFAULT 0,
  records_new       integer NOT NULL DEFAULT 0,
  records_changed   integer NOT NULL DEFAULT 0,
  notice_ids        text[] NOT NULL DEFAULT '{}',
  opportunity_ids   uuid[] NOT NULL DEFAULT '{}',
  message           text,
  sync_run_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX targeted_searches_created_idx ON targeted_searches (created_at DESC);

-- ---------------------------------------------------------------------
-- Keyword edits on built-in capabilities used to be overwritten by the
-- seed on every restart. Edited rows are now flagged and preserved.
-- ---------------------------------------------------------------------
ALTER TABLE capabilities ADD COLUMN keywords_customized boolean NOT NULL DEFAULT false;

-- When GovCheck last spent a SAM.gov API request checking this opportunity (even if SAM
-- returned nothing), so the priority planner does not re-check it every run.
ALTER TABLE opportunities ADD COLUMN sam_live_checked_at timestamptz;

-- Fast lookup of the most recent live check per source record (SAM priority planner).
CREATE INDEX source_records_connector_retrieved_idx ON source_records (connector_id, retrieved_at);
CREATE INDEX opportunity_identifiers_opp_type_idx ON opportunity_identifiers (opportunity_id, id_type);

ALTER TABLE api_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE targeted_searches ENABLE ROW LEVEL SECURITY;
