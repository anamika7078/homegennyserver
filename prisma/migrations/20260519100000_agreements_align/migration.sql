-- Align agreements table with Prisma Agreement model (fixes send-otp 500)

ALTER TABLE agreements ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES staff_applicants(id);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS placement_id UUID;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ(6);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_agreements_staff ON agreements(staff_id);
