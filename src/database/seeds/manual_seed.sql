-- ═══════════════════════════════════════════════════════════════════════════
-- HomeGenny — All portal login users (SQL backup method)
-- Prefer: npm run seed:run  (handles bcrypt + enum extension automatically)
--
-- If using this file manually:
--   1. Generate hash: node -e "require('bcryptjs').hash('HomeGenny@2024',12).then(console.log)"
--   2. Hash already filled in below (HomeGenny@2024, bcrypt rounds=12)
--   3. Run as DB owner (postgres) if TRAINER/ASSESSOR/SUPPORT enum values are missing
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'TRAINER';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ASSESSOR';
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'SUPPORT';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Password for all: HomeGenny@2024

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'BM', 'Amit Gupta', '9800000001', 'bm@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'RM', 'Pooja Mishra', '9800000002', 'rm@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'ADMIN', 'Super Admin', '9800000003', 'admin@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'FINANCE', 'Rajesh Finance', '9800000004', 'finance@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'TRAINER', 'Sunita Trainer', '9800000005', 'trainer@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'ASSESSOR', 'Dr. Kavita Assessor', '9800000006', 'assessor@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (NULL, 'SUPPORT', 'Ops Support', '9800000007', 'support@homegenny.com', '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a', true)
ON CONFLICT (phone) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name,
  email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = NOW();

SELECT phone, role, full_name, is_active FROM users WHERE phone LIKE '980000000%' ORDER BY phone;
