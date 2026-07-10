-- Staff daily attendance for RM deployment attendance tracking
CREATE TYPE staff_attendance_status AS ENUM ('PRESENT', 'ABSENT', 'LEAVE', 'OVERTIME');

CREATE TABLE IF NOT EXISTS staff_daily_attendance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        UUID NOT NULL REFERENCES staff_applicants(id),
  placement_id    UUID,
  branch_id       UUID NOT NULL REFERENCES branches(id),
  attendance_date DATE NOT NULL,
  status          staff_attendance_status NOT NULL,
  overtime_hours  DECIMAL(4,1),
  marked_by       UUID NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(staff_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_daily_attendance_branch_date
  ON staff_daily_attendance(branch_id, attendance_date);
