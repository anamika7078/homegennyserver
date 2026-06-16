-- Align staff_applicants with Prisma enterprise model (fixes BM/RM staff API 500s)

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS restricted_list_flag BOOLEAN NOT NULL DEFAULT false;
UPDATE staff_applicants
SET restricted_list_flag = COALESCE(restricted_list, false)
WHERE restricted_list_flag IS DISTINCT FROM COALESCE(restricted_list, false);

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS current_scenario_code VARCHAR(20);
UPDATE staff_applicants
SET current_scenario_code = current_scenario
WHERE current_scenario_code IS NULL AND current_scenario IS NOT NULL;

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS training_start_date DATE;
ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS training_end_date DATE;
ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS deployment_ready_date DATE;

ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS aadhaar_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_staff_user ON staff_applicants(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_restricted_flag ON staff_applicants(restricted_list_flag) WHERE restricted_list_flag = true;
