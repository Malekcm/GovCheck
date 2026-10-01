-- Lock down every application table at the row-level-security layer.
--
-- The browser never talks to the database directly: all reads/writes go through
-- the server API, which connects with a privileged role (the Supabase `postgres`
-- role / service role bypasses RLS). Enabling RLS with no permissive policies means
-- Supabase's auto-generated REST/GraphQL endpoints expose NOTHING to the `anon` or
-- `authenticated` roles, even if the anon key leaks.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
