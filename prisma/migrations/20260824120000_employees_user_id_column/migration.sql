-- Additive: link employees to a login-capable users row (nullable, backward compatible).
-- schema.prisma has had Employee.userId since before this session, but no migration ever
-- created the column on a fresh/migrate-deploy'd database (it only existed on DBs someone
-- ran `prisma db push` against directly) — confirmed live: GET /user/profile 500s on
-- production with "column employees.user_id does not exist", while the local dev DB (which
-- had been `db push`-ed at some point) already has it. Same pattern as the
-- staff_applicants_user_id_unique migration this mirrors.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE employees ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE employees ADD CONSTRAINT employees_user_id_key UNIQUE (user_id);
CREATE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id);
