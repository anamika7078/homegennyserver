-- ═══════════════════════════════════════════════════════════════════════════
-- HomeGenny — Manual Admin User Seed (SQL backup method)
-- Use this ONLY if npm run seed:run fails.
--
-- STEP 1: Generate the bcrypt hash on the SERVER first:
--   docker compose exec backend node -e \
--     "require('bcryptjs').hash('HomeGenny@2024',12).then(h=>console.log(h))"
--
--   Copy the hash output (starts with $2a$12$...)
--
-- STEP 2: Replace PASTE_HASH_HERE below with the copied hash.
--
-- STEP 3: Run this file:
--   docker compose exec db psql -U hguser homegenny < manual_seed.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Default branch
INSERT INTO branches (id, name, city, state, email)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'HomeGenny Delhi NCR HQ', 'New Delhi', 'Delhi', 'delhi@homegenny.com'
) ON CONFLICT (id) DO NOTHING;

-- BM user  (replace PASTE_HASH_HERE with output of the node command above)
INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'BM', 'Amit Gupta', '9800000001', '9800000001@homegenny.com',
  'PASTE_HASH_HERE',
  true
) ON CONFLICT (phone) DO UPDATE
  SET password_hash = 'PASTE_HASH_HERE', is_active = true, updated_at = NOW();

-- RM user
INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'RM', 'Pooja Mishra', '9800000002', '9800000002@homegenny.com',
  'PASTE_HASH_HERE',
  true
) ON CONFLICT (phone) DO UPDATE
  SET password_hash = 'PASTE_HASH_HERE', is_active = true, updated_at = NOW();

SELECT id, full_name, phone, role, is_active FROM users ORDER BY created_at;
