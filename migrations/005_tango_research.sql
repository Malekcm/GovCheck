-- Only quota metadata and user-authored research belong here. No provider payloads.
CREATE TABLE tango_budget (
  account_id text PRIMARY KEY,
  usage_day date NOT NULL,
  usage_month text NOT NULL,
  used integer NOT NULL DEFAULT 0,
  background_used integer NOT NULL DEFAULT 0,
  month_used integer NOT NULL DEFAULT 0,
  test_used integer NOT NULL DEFAULT 0,
  provider_remaining integer,
  provider_reset timestamptz,
  blocked_until timestamptz,
  last_dispatch timestamptz,
  last_success timestamptz,
  last_test_success timestamptz,
  auth_blocked boolean NOT NULL DEFAULT false
);
CREATE TABLE tango_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL REFERENCES tango_budget(account_id),
  endpoint text NOT NULL,
  category text NOT NULL CHECK (category IN ('manual','background','test')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'reserved',
  http_status integer,
  provider_remaining integer
);
CREATE INDEX tango_requests_account_time ON tango_requests(account_id, attempted_at);
CREATE TABLE research_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL CHECK (source_name IN ('OrangeSlices','Manual')),
  source_url text NOT NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  company_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  category text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','rejected')),
  notes text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','reviewed','dismissed'))
);
ALTER TABLE tango_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE tango_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_signals ENABLE ROW LEVEL SECURITY;
