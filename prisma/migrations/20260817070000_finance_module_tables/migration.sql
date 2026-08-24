-- The finance module tables (finance_customers and friends) were pushed to the
-- original production database with `prisma db push` and never captured in a
-- migration, so `prisma migrate deploy` against a fresh database fails as soon
-- as a later migration (20260817071500_agreements_client_fk_fix) references
-- finance_customers. This migration backfills the missing tables so migration
-- history can be replayed in full on a brand-new database. All statements are
-- IF NOT EXISTS so this is a no-op on databases that already have these tables
-- from the earlier db-push.

CREATE TABLE IF NOT EXISTS finance_customers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID UNIQUE REFERENCES users(id),
  customer_name  VARCHAR(255) NOT NULL,
  address        TEXT NOT NULL,
  city           VARCHAR(100),
  state          VARCHAR(100),
  pincode        VARCHAR(20),
  pan_card       VARCHAR(20) NOT NULL,
  gstn           VARCHAR(20),
  bill_no_prefix VARCHAR(30) NOT NULL,
  bill_seq       INT NOT NULL DEFAULT 0,
  unit_code      VARCHAR(20) NOT NULL UNIQUE,
  unit_name      VARCHAR(255) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_customers_unitcode_idx ON finance_customers(unit_code);
CREATE INDEX IF NOT EXISTS finance_customers_pancard_idx ON finance_customers(pan_card);
CREATE INDEX IF NOT EXISTS idx_finance_customers_pan_card ON finance_customers(pan_card);
CREATE INDEX IF NOT EXISTS idx_finance_customers_unit_code ON finance_customers(unit_code);

CREATE TABLE IF NOT EXISTS finance_wage_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state                VARCHAR(100) NOT NULL,
  zone                 VARCHAR(100) NOT NULL,
  effective_date       DATE NOT NULL,
  category             VARCHAR(100) NOT NULL,
  basic_wage           DECIMAL(10,2) NOT NULL,
  da                   DECIMAL(10,2) NOT NULL,
  hra                  DECIMAL(10,2) NOT NULL,
  skilled_allowance    DECIMAL(10,2) NOT NULL,
  additional_hours_pct DECIMAL(5,2) NOT NULL,
  employer_pf_pct      DECIMAL(5,2) NOT NULL,
  employer_pf_max      DECIMAL(10,2) NOT NULL,
  employee_pf_pct      DECIMAL(5,2) NOT NULL,
  employer_esic_pct    DECIMAL(5,2) NOT NULL,
  employee_esic_pct    DECIMAL(5,2) NOT NULL,
  bonus_pct            DECIMAL(5,2) NOT NULL,
  leave_days           INT NOT NULL,
  lwf_pct              DECIMAL(5,2) NOT NULL,
  lwf_max              DECIMAL(10,2) NOT NULL,
  uniform_allowance    DECIMAL(10,2) NOT NULL,
  relieving_pct        DECIMAL(5,2) NOT NULL,
  management_pct       DECIMAL(5,2) NOT NULL,
  training_charges     DECIMAL(10,2) NOT NULL,
  gst_pct              DECIMAL(5,2) NOT NULL,
  professional_tax     DECIMAL(10,2) NOT NULL,
  nfh                  DECIMAL(10,2) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_commercial_calculations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID REFERENCES finance_customers(id),
  customer_name      VARCHAR(255) NOT NULL,
  unit_code          VARCHAR(50) NOT NULL,
  branch_id          UUID,
  branch_name        VARCHAR(255),
  state              VARCHAR(100) NOT NULL,
  zone               VARCHAR(100) NOT NULL,
  contract_duration  INT NOT NULL,
  revision_number    INT NOT NULL DEFAULT 1,
  total_monthly_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_gst          DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_grand_total  DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_resources    INT NOT NULL DEFAULT 0,
  status             VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_by         VARCHAR(255),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_approval (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id UUID NOT NULL REFERENCES finance_commercial_calculations(id) ON DELETE CASCADE,
  stage          VARCHAR(50) NOT NULL,
  status         VARCHAR(50) NOT NULL,
  comments       TEXT,
  user_id        UUID,
  user_name      VARCHAR(255),
  approval_date  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_commercial_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id    UUID NOT NULL REFERENCES finance_commercial_calculations(id) ON DELETE CASCADE,
  category          VARCHAR(100) NOT NULL,
  no_of_resources   INT NOT NULL,
  working_hours     DECIMAL(5,2) NOT NULL,
  shift_type        VARCHAR(50) NOT NULL,
  wage_config_id    UUID REFERENCES finance_wage_config(id),
  basic             DECIMAL(10,2) NOT NULL,
  da                DECIMAL(10,2) NOT NULL,
  hra               DECIMAL(10,2) NOT NULL,
  skilled_allowance DECIMAL(10,2) NOT NULL,
  additional_hours  DECIMAL(10,2) NOT NULL,
  subtotal1         DECIMAL(10,2) NOT NULL,
  subtotal2         DECIMAL(10,2) NOT NULL,
  employer_pf       DECIMAL(10,2) NOT NULL,
  bonus             DECIMAL(10,2) NOT NULL,
  leave_wages       DECIMAL(10,2) NOT NULL,
  esic              DECIMAL(10,2) NOT NULL,
  lwf               DECIMAL(10,2) NOT NULL,
  uniform           DECIMAL(10,2) NOT NULL,
  nfh               DECIMAL(10,2) NOT NULL,
  subtotal3         DECIMAL(10,2) NOT NULL,
  relieving         DECIMAL(10,2) NOT NULL,
  subtotal4         DECIMAL(10,2) NOT NULL,
  management_fee    DECIMAL(10,2) NOT NULL,
  training_charges  DECIMAL(10,2) NOT NULL,
  monthly_cost      DECIMAL(10,2) NOT NULL,
  daily_rate        DECIMAL(10,2) NOT NULL,
  hourly_rate       DECIMAL(10,2) NOT NULL,
  gst               DECIMAL(10,2) NOT NULL,
  grand_total       DECIMAL(10,2) NOT NULL,
  gross_salary      DECIMAL(10,2) NOT NULL,
  employee_pf       DECIMAL(10,2) NOT NULL,
  employee_esic     DECIMAL(10,2) NOT NULL,
  professional_tax  DECIMAL(10,2) NOT NULL,
  net_salary        DECIMAL(10,2) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_quotations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_number   VARCHAR(100) NOT NULL UNIQUE,
  calculation_id     UUID REFERENCES finance_commercial_calculations(id),
  customer_id        UUID REFERENCES finance_customers(id),
  customer_name      VARCHAR(255) NOT NULL,
  unit_code          VARCHAR(50) NOT NULL,
  date               DATE NOT NULL,
  validity           DATE NOT NULL,
  prepared_by        VARCHAR(255) NOT NULL,
  status             VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  terms_conditions   TEXT,
  total_monthly_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_gst          DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_grand_total  DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_quotation_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id    UUID NOT NULL REFERENCES finance_quotations(id) ON DELETE CASCADE,
  category        VARCHAR(100) NOT NULL,
  no_of_resources INT NOT NULL,
  monthly_rate    DECIMAL(10,2) NOT NULL,
  gst             DECIMAL(10,2) NOT NULL,
  grand_total     DECIMAL(10,2) NOT NULL,
  daily_rate      DECIMAL(10,2) NOT NULL,
  hourly_rate     DECIMAL(10,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_rate_cards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id UUID REFERENCES finance_commercial_calculations(id),
  customer_id    UUID REFERENCES finance_customers(id),
  customer_name  VARCHAR(255) NOT NULL,
  unit_code      VARCHAR(50) NOT NULL,
  category       VARCHAR(100) NOT NULL,
  monthly_rate   DECIMAL(10,2) NOT NULL,
  daily_rate     DECIMAL(10,2) NOT NULL,
  hourly_rate    DECIMAL(10,2) NOT NULL,
  effective_date DATE NOT NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action     VARCHAR(100) NOT NULL,
  module     VARCHAR(100) NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}',
  user_id    UUID,
  user_name  VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
