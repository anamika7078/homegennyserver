-- ─────────────────────────────────────────────────────────────────────────
-- Phase 2 security hardening: dedicated, non-superuser application DB role.
--
-- Run once per environment (as the bootstrap superuser, e.g. `postgres`)
-- against a fresh or existing HomeGenny database. Idempotent-ish: re-running
-- CREATE ROLE will error if it already exists — use ALTER ROLE ... PASSWORD
-- to rotate the password instead.
--
-- Why the app role OWNS its tables (rather than just holding GRANTs): several
-- existing startup paths (SchemaBootstrapService, FinanceCustomerService,
-- render_pre_migrate.js) run idempotent DDL — CREATE TABLE IF NOT EXISTS /
-- ALTER TABLE ... ADD COLUMN — using the app's own runtime connection. ALTER
-- TABLE requires table ownership in Postgres, not just a grant, so the app
-- role must own its schema for that existing behavior to keep working. The
-- append-only guarantee on pipeline_events / admin_audit_logs is NOT enforced
-- by revoking UPDATE/DELETE (an owning role can always re-grant itself
-- privileges on objects it owns, so that would be a fake boundary) — it's
-- enforced by the BEFORE UPDATE/DELETE trigger in apply_security_triggers.js,
-- which fires regardless of ownership or privilege level.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Create the role. Replace the password before running, or set it via
--    ALTER ROLE afterward — never commit a real password in this file.
CREATE ROLE homegenny_user WITH LOGIN PASSWORD '<set-a-strong-password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- 2. Grant connect + full schema/table/sequence privileges.
GRANT CONNECT ON DATABASE homegenny TO homegenny_user;
GRANT ALL PRIVILEGES ON SCHEMA public TO homegenny_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO homegenny_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO homegenny_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO homegenny_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO homegenny_user;

-- 3. Transfer ownership of every existing table/sequence/view/function from
--    the bootstrap role to homegenny_user. `REASSIGN OWNED BY postgres TO ...`
--    does NOT work here — Postgres refuses it with "cannot reassign ownership
--    of objects owned by role postgres because they are required by the
--    database system" on the bootstrap superuser role — so this does it
--    object-by-object instead. Run as a single psql session or via the
--    equivalent one-off Node script (see git history / PHASE_2 report for
--    the exact script used) if you need this scripted rather than manual.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tableowner='postgres' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO homegenny_user', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' AND sequenceowner='postgres' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO homegenny_user', r.sequencename);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' AND viewowner='postgres' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO homegenny_user', r.viewname);
  END LOOP;
END $$;

-- Functions need argument types to disambiguate overloads, so these are
-- listed explicitly rather than looped:
-- ALTER FUNCTION public.prevent_update_delete() OWNER TO homegenny_user;

-- 4. Verify.
-- SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
-- FROM pg_roles WHERE rolname = 'homegenny_user';
-- Expect: rolsuper = false, everything else false too.

-- 5. Point DATABASE_URL at this role in every environment's config, then run
--    scratch/apply_security_triggers.js (already wired into start/start:prod/
--    render_start.sh) to (re)apply the append-only triggers.
