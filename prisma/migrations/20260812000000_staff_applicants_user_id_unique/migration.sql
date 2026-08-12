-- Additive: link staff_applicants to a login-capable users row (nullable, backward compatible).
ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE staff_applicants ADD CONSTRAINT staff_applicants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE staff_applicants ADD CONSTRAINT staff_applicants_user_id_key UNIQUE (user_id);
CREATE INDEX IF NOT EXISTS idx_staff_applicants_user_id ON staff_applicants(user_id);
