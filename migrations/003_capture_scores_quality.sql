-- =====================================================================
-- 003: BD capture pipeline, separated score dimensions, requirement
-- strength, and indexes for a growing historical dataset.
-- Additive only — no existing data is modified or removed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Capture pipeline (user-owned; sync never writes these tables)
-- ---------------------------------------------------------------------
CREATE TABLE opportunity_capture (
  opportunity_id      uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  pursuit_stage       text NOT NULL DEFAULT 'discovered', -- discovered | reviewing | qualified | capture | bid_decision | proposal | submitted | awarded | lost | no_bid
  owner               text,
  priority            text,            -- high | medium | low
  win_probability     integer CHECK (win_probability BETWEEN 0 AND 100),
  next_action         text,
  next_action_date    date,
  proposal_deadline   timestamptz,
  bid_decision        text,            -- bid | no_bid | pending
  partners            text[] NOT NULL DEFAULT '{}',
  capture_notes       text,
  win_themes          text,
  risks               text,
  questions           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_capture_stage_idx ON opportunity_capture (pursuit_stage);
CREATE INDEX opportunity_capture_next_idx ON opportunity_capture (next_action_date);

-- Every capture edit is journaled so pipeline history is never lost.
CREATE TABLE opportunity_capture_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  changes         jsonb NOT NULL,   -- { field: [old, new] }
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_capture_history_opp_idx ON opportunity_capture_history (opportunity_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- Separate score dimensions. Fit stays the objective company-fit score;
-- these never overwrite it.
-- ---------------------------------------------------------------------
ALTER TABLE opportunities ADD COLUMN attractiveness_score integer;
ALTER TABLE opportunities ADD COLUMN confidence_score integer;
ALTER TABLE opportunities ADD COLUMN priority_score integer;
CREATE INDEX opportunities_priority_idx ON opportunities (priority_score DESC NULLS LAST);

ALTER TABLE match_scores ADD COLUMN attractiveness_score integer;
ALTER TABLE match_scores ADD COLUMN confidence_score integer;
ALTER TABLE match_scores ADD COLUMN priority_score integer;
ALTER TABLE match_scores ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}';

ALTER TABLE score_history ADD COLUMN priority_score integer;

-- ---------------------------------------------------------------------
-- Requirement strength: an explicit requirement ("offerors shall…")
-- versus a mention ("…may require a Secret clearance").
-- ---------------------------------------------------------------------
ALTER TABLE opportunity_requirements ADD COLUMN strength text;   -- explicit | mentioned | inferred

-- ---------------------------------------------------------------------
-- Indexes for scale (hundreds of thousands of profiles / awards)
-- ---------------------------------------------------------------------
CREATE INDEX source_records_seen_idx ON source_records (connector_id, seen_status, last_seen_at);
CREATE INDEX opportunity_documents_pending_idx ON opportunity_documents (retrieval_status) WHERE retrieval_status IN ('not_downloaded', 'failed');
CREATE INDEX opportunity_documents_opp_idx ON opportunity_documents (opportunity_id);
CREATE INDEX opportunity_events_opp_detected_idx ON opportunity_events (opportunity_id, detected_at DESC);
CREATE INDEX opportunity_events_type_idx ON opportunity_events (event_type, detected_at DESC);
CREATE INDEX decisions_current_opp_idx ON user_opportunity_decisions (opportunity_id) WHERE is_current;
CREATE INDEX opportunities_perf_end_idx ON opportunities (performance_end);
CREATE INDEX opportunities_status_idx ON opportunities (status);
CREATE INDEX opportunities_first_seen_idx ON opportunities (first_seen_at DESC);
CREATE INDEX field_values_source_idx ON opportunity_field_values (source_record_id);
CREATE INDEX opportunity_relationships_status_idx ON opportunity_relationships (status, relationship_type);
CREATE INDEX awards_idv_idx ON awards (referenced_idv_piid);
CREATE INDEX awards_uei_idx ON awards (awardee_uei);

ALTER TABLE opportunity_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_capture_history ENABLE ROW LEVEL SECURITY;
