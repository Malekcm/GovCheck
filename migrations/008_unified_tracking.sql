-- Unified opportunity tracking, discovery attribution and research leads.
-- Additive only. No provider-controlled (G2X / Tango) content is stored by this schema:
--  * opportunity_tracking / _history  : user-authored capture tracking state (category 2)
--  * opportunity_discovery            : minimal discovery attribution — provider name, the record
--                                       link the user chose to keep, who/when (category 3)
--  * discovery_match_decisions        : the user's decision about a discovery result, keyed by a
--                                       one-way hash of the provider record link (category 3)
-- Government records continue to live only in source_records (category 1).

ALTER TABLE opportunities ADD COLUMN verification_status text NOT NULL DEFAULT 'government_verified'
  CHECK (verification_status IN ('government_verified','research_lead'));
ALTER TABLE opportunities ADD COLUMN first_discovered_source text;
ALTER TABLE opportunities ADD COLUMN first_discovered_at timestamptz;

CREATE TABLE opportunity_tracking (
  opportunity_id uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  tracked        boolean NOT NULL DEFAULT true,
  tracked_at     timestamptz NOT NULL DEFAULT now(),
  tracked_by     uuid REFERENCES team_members(user_id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES team_members(user_id),
  version        integer NOT NULL DEFAULT 1
);
CREATE TABLE opportunity_tracking_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES team_members(user_id),
  request_id     uuid UNIQUE,
  change         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opportunity_discovery (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id      uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  provider            text NOT NULL,             -- g2x | tango | manual | <connector id>
  provider_record_key text NOT NULL,             -- sha256 of the provider record link (never content)
  provider_record_url text,                      -- the link the user chose to keep, when permitted
  is_lead_origin      boolean NOT NULL DEFAULT false,
  discovered_by       uuid REFERENCES team_members(user_id),
  discovered_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, provider, provider_record_key)
);
-- One research lead per provider record: double-clicks, retries and concurrent requests converge.
CREATE UNIQUE INDEX discovery_one_lead_per_record ON opportunity_discovery(provider, provider_record_key) WHERE is_lead_origin;
CREATE INDEX discovery_lookup ON opportunity_discovery(provider, provider_record_key);

CREATE TABLE discovery_match_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_record_key text NOT NULL,
  opportunity_id      uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  decision            text NOT NULL CHECK (decision IN ('linked','separate','predecessor','successor','dismissed')),
  decided_by          uuid REFERENCES team_members(user_id),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (provider, provider_record_key, opportunity_id)
);
CREATE INDEX discovery_decisions_key ON discovery_match_decisions(provider, provider_record_key);

-- The 'user_research_lead' manual source is registered at startup (connectors/registry.ts), like the
-- built-in connectors, so database promotion copies one identical row.

-- Backfill first-discovered attribution from the earliest linked source record.
UPDATE opportunities o SET first_discovered_source = x.connector_id, first_discovered_at = x.first_seen_at
FROM (
  SELECT DISTINCT ON (os.opportunity_id) os.opportunity_id, sr.connector_id, sr.first_seen_at
  FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id
  ORDER BY os.opportunity_id, sr.first_seen_at, sr.connector_id
) x WHERE x.opportunity_id = o.id AND o.first_discovered_source IS NULL;

ALTER TABLE opportunity_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_tracking_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_discovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_match_decisions ENABLE ROW LEVEL SECURITY;
