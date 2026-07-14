-- CreateTable (was in schema.prisma but missing from prior migrations)
CREATE TABLE IF NOT EXISTS "employee_payrolls" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "present_days" DECIMAL(5,2) NOT NULL,
    "gross_salary" DECIMAL(10,2) NOT NULL,
    "deductions" JSONB NOT NULL DEFAULT '{}',
    "net_salary" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "disbursed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_payrolls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "employee_payrolls_employee_id_period_month_period_year_key"
  ON "employee_payrolls"("employee_id", "period_month", "period_year");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_payrolls_employee_id_fkey'
  ) THEN
    ALTER TABLE "employee_payrolls"
      ADD CONSTRAINT "employee_payrolls_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
