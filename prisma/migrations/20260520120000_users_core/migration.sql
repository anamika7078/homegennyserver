-- Core auth tables: branches + users (portal logins)

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'STAFF', 'CLIENT', 'RM', 'BM', 'FINANCE', 'ADMIN',
    'TRAINER', 'ASSESSOR', 'SUPPORT'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS branches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  state       VARCHAR(100) NOT NULL,
  gstin       VARCHAR(20),
  address     TEXT,
  phone       VARCHAR(20),
  email       VARCHAR(100),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO branches (id, name, city, state, email)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'HomeGenny Delhi NCR HQ',
  'New Delhi',
  'Delhi',
  'delhi@homegenny.com'
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           UUID REFERENCES branches(id),
  role                user_role NOT NULL,
  full_name           VARCHAR(200) NOT NULL,
  phone               VARCHAR(20) UNIQUE NOT NULL,
  email               VARCHAR(200) UNIQUE,
  password_hash       VARCHAR(255),
  refresh_token_hash  VARCHAR(255),
  active_session_id   VARCHAR(64),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_login_at       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
