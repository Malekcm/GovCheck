-- Additive: legacy actor and capture-owner text remain untouched.
CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
INSERT INTO organizations(id,name) VALUES ('00000000-0000-4000-8000-000000000001','GovCheck');
CREATE TABLE team_members (
 user_id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 email text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','manager','member','viewer')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_sessions (
 id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_members(user_id), credentials text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES team_members(user_id),
 method text NOT NULL, path text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE opportunity_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opportunity_id uuid NOT NULL REFERENCES opportunities(id),
 user_id uuid NOT NULL REFERENCES team_members(user_id), assignment_role text NOT NULL CHECK(assignment_role IN ('owner','collaborator')),
 status text NOT NULL DEFAULT 'Not Started' CHECK(status IN ('Not Started','Researching','Awaiting Review','Complete','Blocked')),
 next_action text, due_date date, assigned_by uuid REFERENCES team_members(user_id), assigned_at timestamptz NOT NULL DEFAULT now(),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX assignments_active_user ON opportunity_assignments(opportunity_id,user_id) WHERE active;
CREATE UNIQUE INDEX assignments_primary_owner ON opportunity_assignments(opportunity_id) WHERE active AND assignment_role='owner';
CREATE INDEX assignments_workload ON opportunity_assignments(user_id,due_date) WHERE active;
CREATE TABLE assignment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opportunity_id uuid NOT NULL REFERENCES opportunities(id),
 actor_id uuid REFERENCES team_members(user_id), request_id uuid NOT NULL UNIQUE, changes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_notes ADD COLUMN actor_id uuid REFERENCES team_members(user_id);
ALTER TABLE user_opportunity_decisions ADD COLUMN actor_id uuid REFERENCES team_members(user_id);
ALTER TABLE opportunity_capture ADD COLUMN actor_id uuid REFERENCES team_members(user_id);
ALTER TABLE opportunity_capture_history ADD COLUMN actor_id uuid REFERENCES team_members(user_id);
CREATE TABLE research_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opportunity_id uuid NOT NULL REFERENCES opportunities(id),
 initiated_by uuid NOT NULL REFERENCES team_members(user_id), reviewed_by uuid REFERENCES team_members(user_id), reviewed_at timestamptz,
 skill_version text NOT NULL, model text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 origin_opportunity_id uuid NOT NULL REFERENCES opportunities(id), snapshot_hash text NOT NULL, snapshot jsonb NOT NULL, report jsonb, usage jsonb, error text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, lease_until timestamptz, claim_id uuid,
 UNIQUE(origin_opportunity_id,snapshot_hash,skill_version)
);
CREATE TABLE g2x_connections (
 user_id uuid PRIMARY KEY REFERENCES team_members(user_id), credentials text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_states (
 state text PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_members(user_id), verifier text NOT NULL,
 metadata jsonb NOT NULL, expires_at timestamptz NOT NULL
);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE g2x_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
-- No Data API policies: all access goes through the authenticated server.

ALTER TABLE opportunities ADD COLUMN assignment_revision integer NOT NULL DEFAULT 0;
CREATE TABLE team_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES team_members(user_id),
 research_run_id uuid NOT NULL UNIQUE REFERENCES research_runs(id),created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz
);
CREATE TABLE research_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),research_run_id uuid NOT NULL REFERENCES research_runs(id),
 user_id uuid NOT NULL REFERENCES team_members(user_id),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE team_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_feedback ENABLE ROW LEVEL SECURITY;
