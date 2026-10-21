-- Application UUIDs remain stable across authentication providers.
ALTER TABLE team_members ADD COLUMN auth_provider text NOT NULL DEFAULT 'supabase';
ALTER TABLE team_members ADD COLUMN auth_subject text;
UPDATE team_members SET auth_subject=user_id::text;
CREATE UNIQUE INDEX team_auth_identity ON team_members(auth_provider,auth_subject) WHERE auth_subject IS NOT NULL;
CREATE UNIQUE INDEX team_email_casefold ON team_members(lower(email));
CREATE TABLE auth_rate_limits (
 key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL
);
ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
