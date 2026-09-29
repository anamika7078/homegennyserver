import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Ensures module-critical tables exist on deployed DBs that skipped TypeORM / partial Prisma migrations. */
@Injectable()
export class SchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(SchemaBootstrapService.name);
  private ready: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureModuleTables();
    } catch (err) {
      this.logger.error(
        `Schema bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async ensureModuleTables(): Promise<void> {
    if (!this.ready) {
      this.ready = this.runBootstrap().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  /** Prisma/pg poolers reject multi-statement prepared queries — run one DDL per call. */
  private async exec(sql: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(sql);
  }

  private async tablesExist(): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<{ batches: string | null }[]>(`
      SELECT to_regclass('public.training_batches')::text AS batches
    `);
    return Boolean(rows[0]?.batches);
  }

  private async ensureBranchColumns(): Promise<void> {
    try {
      await this.exec(`DO $$ BEGIN ALTER TABLE branches ADD COLUMN fee_structure JSONB DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
      await this.exec(`DO $$ BEGIN ALTER TABLE branches ADD COLUMN agreement_template TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    } catch (e: any) {
      this.logger.error(`Error bootstrapping branch columns: ${e?.message}`);
    }
  }

  private async ensureAppendOnlyTriggers(): Promise<void> {
    try {
      await this.exec(`
        CREATE OR REPLACE FUNCTION prevent_pipeline_events_mutation()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'pipeline_events is an immutable append-only table. UPDATE and DELETE operations are strictly forbidden at database level.';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await this.exec(`
        DO $$ BEGIN
          CREATE TRIGGER check_pipeline_events_append_only
          BEFORE UPDATE OR DELETE ON pipeline_events
          FOR EACH ROW EXECUTE FUNCTION prevent_pipeline_events_mutation();
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
      `);
      this.logger.log('Pipeline events append-only DB trigger enforced.');
    } catch (e: any) {
      this.logger.error(`Error bootstrapping append-only triggers: ${e?.message}`);
    }
  }

  private async runBootstrap(): Promise<void> {
    await this.ensureAppendOnlyTriggers();
    await this.ensureBranchColumns();
    await this.ensureFinanceColumns();
    await this.ensureHrTables();
    await this.ensureCommercialTables();

    // Used to `return` here once training_batches existed, skipping every
    // statement below — including the ALTER/fix-up ones added after this
    // table first went live (trainer_id, end_date, quiz_date, and the
    // staff_id FK retarget), which then could NEVER apply to a database
    // where the table already existed. Every one of those is IF NOT EXISTS
    // or otherwise idempotent, same as everything else in this file, so
    // there's no actual reason to skip them — this now always runs through,
    // matching ensureBranchColumns/ensureFinanceColumns/etc above.
    if (await this.tablesExist()) {
      this.logger.log('Module tables already present (training, finance) — checking for column/constraint fix-ups');
    }

    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_batches (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_code   VARCHAR(40) UNIQUE NOT NULL,
        series       VARCHAR(10) NOT NULL,
        trainer_name VARCHAR(100),
        trainer_id   UUID,
        classroom    VARCHAR(80),
        start_date   DATE NOT NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'UPCOMING',
        branch_id    UUID,
        rm_id        UUID,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS batch_enrollments (
        id         UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        batch_id   UUID NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
        staff_id   UUID NOT NULL REFERENCES staff_applicants(id),
        attendance INTEGER[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(batch_id, staff_id)
      )
    `);

    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_training_batches_branch ON training_batches(branch_id)`,
    );
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_batch_enrollments_batch ON batch_enrollments(batch_id)`,
    );

    // ── Study material — one row per item (video/PDF/note) a trainer attaches
    // to a specific batch. `storage_key` holds the video-cert-style storage
    // key (GCS or local, see local-material-storage.util.ts) for VIDEO, or the
    // local file path for PDF; `body` holds the plain text for NOTE.
    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_materials (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id    UUID NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
        type        VARCHAR(20) NOT NULL,
        title       VARCHAR(200) NOT NULL,
        storage_key TEXT,
        body        TEXT,
        size_bytes  BIGINT,
        uploaded_by UUID,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_training_materials_batch ON training_materials(batch_id)`,
    );

    // ── Quiz — batch-scoped. Questions are MCQ (auto-graded, correct_option
    // known at submit time) or TEXT (a trainer has to read and grade it).
    await this.exec(`
      CREATE TABLE IF NOT EXISTS training_quizzes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id   UUID NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
        title      VARCHAR(200) NOT NULL,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_training_quizzes_batch ON training_quizzes(batch_id)`,
    );

    await this.exec(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quiz_id        UUID NOT NULL REFERENCES training_quizzes(id) ON DELETE CASCADE,
        question_text  TEXT NOT NULL,
        type           VARCHAR(10) NOT NULL DEFAULT 'MCQ',
        options        JSONB,
        correct_option INT,
        order_index    INT NOT NULL DEFAULT 0,
        points         INT NOT NULL DEFAULT 1
      )
    `);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions(quiz_id)`,
    );

    // status: SCHEDULED (trainer-rescheduled, opens at available_at) |
    // IN_PROGRESS | SUBMITTED (TEXT answers awaiting review) | GRADED. A retake
    // is always a new row, so attempt history stays intact.
    await this.exec(`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quiz_id      UUID NOT NULL REFERENCES training_quizzes(id) ON DELETE CASCADE,
        staff_id     UUID NOT NULL REFERENCES staff_applicants(id),
        status       VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
        available_at TIMESTAMPTZ,
        started_at   TIMESTAMPTZ,
        submitted_at TIMESTAMPTZ,
        auto_score   INT,
        max_score    INT,
        passed       BOOLEAN,
        graded_at    TIMESTAMPTZ,
        graded_by    UUID,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id)`,
    );
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_staff ON quiz_attempts(staff_id)`,
    );

    await this.exec(`
      CREATE TABLE IF NOT EXISTS quiz_answers (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attempt_id      UUID NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
        question_id     UUID NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
        selected_option INT,
        answer_text     TEXT,
        is_correct      BOOLEAN,
        points_awarded  INT,
        UNIQUE(attempt_id, question_id)
      )
    `);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_quiz_answers_attempt ON quiz_answers(attempt_id)`,
    );

    // pass_marks NULL means "60% of the quiz's total points", computed at read
    // time so editing a question's points doesn't leave a stale threshold.
    await this.exec(`ALTER TABLE training_quizzes ADD COLUMN IF NOT EXISTS pass_marks INT`);
    await this.exec(`ALTER TABLE training_quizzes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
    await this.exec(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS rescheduled_by UUID`);
    await this.exec(`ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS reschedule_note TEXT`);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS payroll_records (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        placement_id        UUID NOT NULL,
        staff_id            UUID NOT NULL REFERENCES staff_applicants(id),
        period_month        INT NOT NULL,
        period_year         INT NOT NULL,
        shift_days          INT NOT NULL DEFAULT 0,
        gross_salary        DECIMAL(10,2) NOT NULL,
        deductions          JSONB NOT NULL DEFAULT '{}',
        net_salary          DECIMAL(10,2) NOT NULL,
        esic_employer       DECIMAL(10,2) NOT NULL DEFAULT 0,
        esic_employee       DECIMAL(10,2) NOT NULL DEFAULT 0,
        pf_employer         DECIMAL(10,2) NOT NULL DEFAULT 0,
        pf_employee         DECIMAL(10,2) NOT NULL DEFAULT 0,
        disbursed_at        TIMESTAMPTZ,
        disbursement_ref    VARCHAR(100),
        client_invoice_id   UUID,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS client_invoices (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        placement_id              UUID NOT NULL,
        client_id                 UUID NOT NULL,
        invoice_number            VARCHAR(50) UNIQUE NOT NULL,
        period_month              INT NOT NULL,
        period_year               INT NOT NULL,
        staff_salary_component    DECIMAL(10,2) NOT NULL,
        management_fee            DECIMAL(10,2) NOT NULL,
        gst_amount                DECIMAL(10,2) NOT NULL,
        total_amount              DECIMAL(10,2) NOT NULL,
        due_date                  DATE NOT NULL,
        paid_at                   TIMESTAMPTZ,
        payment_ref               VARCHAR(100),
        razorpay_order_id         VARCHAR(100),
        status                    VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_records(period_year, period_month)`,
    );
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_client_invoices_status ON client_invoices(status)`,
    );

    this.logger.log('Module tables verified (training, finance)');
  }

  /** Restore finance columns dropped by partial Prisma migrations on some deployed DBs. */
  private async ensureFinanceColumns(): Promise<void> {
    await this.exec(
      `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS shift_days INT NOT NULL DEFAULT 0`,
    );
    await this.exec(
      `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS client_invoice_id UUID`,
    );
    await this.exec(
      `ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS disbursement_ref VARCHAR(100)`,
    );
    await this.exec(
      `ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0`,
    );
    await this.exec(
      `ALTER TABLE staff_applicants ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN NOT NULL DEFAULT false`,
    );
    await this.exec(
      `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS payment_ref VARCHAR(100)`,
    );
    await this.exec(
      `ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(100)`,
    );
    await this.exec(
      `ALTER TABLE training_batches ADD COLUMN IF NOT EXISTS trainer_id UUID`,
    );
    // Batch duration and quiz date are now set explicitly by the trainer per
    // batch, not derived from a fixed per-series day count — a batch can run
    // however long this specific cohort actually needs.
    await this.exec(
      `ALTER TABLE training_batches ADD COLUMN IF NOT EXISTS end_date DATE`,
    );
    await this.exec(
      `ALTER TABLE training_batches ADD COLUMN IF NOT EXISTS quiz_date DATE`,
    );
    // batch_enrollments.staff_id was created FKing to `employees`, not
    // `staff_applicants` — the CREATE TABLE IF NOT EXISTS above (which does
    // say staff_applicants) never touched it, because on this database the
    // table already existed by the time that line was written, so the clause
    // was a no-op. A trainee at S3_TRAIN is a staff_applicants row, not yet
    // an employees row (that promotion happens after S5, per the HR<->
    // pipeline bridge) — so a real trainee with no employees row of their own
    // 500'd on enroll with a bare FK violation. Idempotent: the IF EXISTS
    // check is false (a no-op) once this has run and fixed it once.
    await this.exec(`
      DO $do$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'batch_enrollments_staff_id_fkey'
            AND confrelid = 'employees'::regclass
        ) THEN
          ALTER TABLE batch_enrollments DROP CONSTRAINT batch_enrollments_staff_id_fkey;
          ALTER TABLE batch_enrollments ADD CONSTRAINT batch_enrollments_staff_id_fkey
            FOREIGN KEY (staff_id) REFERENCES staff_applicants(id);
        END IF;
      END
      $do$;
    `);
    // Ensure all UUID primary key columns have gen_random_uuid() defaults
    // (some tables may have been created before this fix was applied)
    await this.exec(
      `ALTER TABLE batch_enrollments ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
    );
    await this.exec(
      `ALTER TABLE payroll_records ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
    );
    await this.exec(
      `ALTER TABLE client_invoices ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
    );
    await this.exec(
      `ALTER TABLE employee_payrolls ALTER COLUMN id SET DEFAULT gen_random_uuid()`,
    );
  }

  /** HR payroll table — missing from Prisma migrations on some deployed DBs. */
  private async ensureHrTables(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'employee_payrolls'
      ) AS exists
    `);
    if (rows[0]?.exists) return;

    const empRows = await this.prisma.$queryRawUnsafe<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'employees'
      ) AS exists
    `);
    if (!empRows[0]?.exists) {
      this.logger.warn('employees table missing — skipping employee_payrolls bootstrap');
      return;
    }

    await this.exec(`
      CREATE TABLE IF NOT EXISTS employee_payrolls (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        period_month  INT NOT NULL,
        period_year   INT NOT NULL,
        present_days  DECIMAL(5,2) NOT NULL,
        gross_salary  DECIMAL(10,2) NOT NULL,
        deductions    JSONB NOT NULL DEFAULT '{}',
        net_salary    DECIMAL(10,2) NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        disbursed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(employee_id, period_month, period_year)
      )
    `);
    this.logger.log('employee_payrolls table verified');
  }

  private async ensureCommercialTables(): Promise<void> {
    this.logger.log('Verifying Commercial module tables...');

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_name VARCHAR(255) NOT NULL,
        address TEXT NOT NULL,
        pan_card VARCHAR(20) UNIQUE NOT NULL,
        gstn VARCHAR(20),
        bill_no_prefix VARCHAR(30) NOT NULL,
        bill_seq INT NOT NULL DEFAULT 0,
        unit_code VARCHAR(20) UNIQUE NOT NULL,
        unit_name VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE INDEX IF NOT EXISTS idx_finance_customers_unit_code ON finance_customers(unit_code)
    `);
    await this.exec(`
      CREATE INDEX IF NOT EXISTS idx_finance_customers_pan_card ON finance_customers(pan_card)
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_customer_branches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES finance_customers(id) ON DELETE CASCADE,
        unit_code VARCHAR(50) UNIQUE NOT NULL,
        unit_name VARCHAR(255) NOT NULL,
        address TEXT,
        state VARCHAR(100),
        city VARCHAR(100),
        pincode VARCHAR(20),
        gstn VARCHAR(50),
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      DO $$ BEGIN ALTER TABLE finance_customer_branches ADD COLUMN pincode VARCHAR(20); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);

    await this.exec(`
      CREATE INDEX IF NOT EXISTS idx_finance_customer_branches_customer_id ON finance_customer_branches(customer_id)
    `);
    await this.exec(`
      CREATE INDEX IF NOT EXISTS idx_finance_customer_branches_unit_code ON finance_customer_branches(unit_code)
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_wage_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        state VARCHAR(100) NOT NULL,
        zone VARCHAR(100) NOT NULL,
        effective_date DATE NOT NULL,
        category VARCHAR(100) NOT NULL,
        basic_wage DECIMAL(10, 2) NOT NULL,
        da DECIMAL(10, 2) NOT NULL,
        hra DECIMAL(10, 2) NOT NULL,
        skilled_allowance DECIMAL(10, 2) NOT NULL,
        additional_hours_pct DECIMAL(5, 2) NOT NULL,
        employer_pf_pct DECIMAL(5, 2) NOT NULL,
        employer_pf_max DECIMAL(10, 2) NOT NULL,
        employee_pf_pct DECIMAL(5, 2) NOT NULL,
        employer_esic_pct DECIMAL(5, 2) NOT NULL,
        employee_esic_pct DECIMAL(5, 2) NOT NULL,
        bonus_pct DECIMAL(5, 2) NOT NULL,
        leave_days INT NOT NULL,
        lwf_pct DECIMAL(5, 2) NOT NULL,
        lwf_max DECIMAL(10, 2) NOT NULL,
        uniform_allowance DECIMAL(10, 2) NOT NULL,
        relieving_pct DECIMAL(5, 2) NOT NULL,
        management_pct DECIMAL(5, 2) NOT NULL,
        training_charges DECIMAL(10, 2) NOT NULL,
        gst_pct DECIMAL(5, 2) NOT NULL,
        professional_tax DECIMAL(10, 2) NOT NULL,
        nfh DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Add toggle & frequency columns to finance_wage_config (idempotent) ──
    const newCols = [
      { name: 'pf_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'esic_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'bonus_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'bonus_frequency', def: `VARCHAR(10) NOT NULL DEFAULT 'monthly'` },
      { name: 'lwf_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'uniform_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'relieving_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'nfh_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'shift_pattern', def: `VARCHAR(10) NOT NULL DEFAULT '8'` },
      { name: 'gst_applicable', def: `BOOLEAN NOT NULL DEFAULT true` },
      { name: 'gst_type', def: `VARCHAR(20) NOT NULL DEFAULT 'intra_state'` },
    ];
    for (const col of newCols) {
      await this.exec(`
        DO $$ BEGIN
          ALTER TABLE finance_wage_config ADD COLUMN ${col.name} ${col.def};
        EXCEPTION WHEN duplicate_column THEN NULL; END $$
      `);
    }


    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_commercial_calculations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES finance_customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        unit_code VARCHAR(50) NOT NULL,
        branch_id UUID,
        branch_name VARCHAR(255),
        state VARCHAR(100) NOT NULL,
        zone VARCHAR(100) NOT NULL,
        contract_duration INT NOT NULL,
        revision_number INT NOT NULL DEFAULT 1,
        total_monthly_cost DECIMAL(12, 2) NOT NULL DEFAULT 0,
        total_gst DECIMAL(12, 2) NOT NULL DEFAULT 0,
        total_grand_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
        total_resources INT NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_commercial_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        calculation_id UUID NOT NULL REFERENCES finance_commercial_calculations(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        no_of_resources INT NOT NULL,
        working_hours DECIMAL(5, 2) NOT NULL,
        shift_type VARCHAR(50) NOT NULL,
        wage_config_id UUID REFERENCES finance_wage_config(id) ON DELETE SET NULL,
        basic DECIMAL(10, 2) NOT NULL,
        da DECIMAL(10, 2) NOT NULL,
        hra DECIMAL(10, 2) NOT NULL,
        skilled_allowance DECIMAL(10, 2) NOT NULL,
        additional_hours DECIMAL(10, 2) NOT NULL,
        subtotal1 DECIMAL(10, 2) NOT NULL,
        subtotal2 DECIMAL(10, 2) NOT NULL,
        employer_pf DECIMAL(10, 2) NOT NULL,
        bonus DECIMAL(10, 2) NOT NULL,
        leave_wages DECIMAL(10, 2) NOT NULL,
        esic DECIMAL(10, 2) NOT NULL,
        lwf DECIMAL(10, 2) NOT NULL,
        uniform DECIMAL(10, 2) NOT NULL,
        nfh DECIMAL(10, 2) NOT NULL,
        subtotal3 DECIMAL(10, 2) NOT NULL,
        relieving DECIMAL(10, 2) NOT NULL,
        subtotal4 DECIMAL(10, 2) NOT NULL,
        management_fee DECIMAL(10, 2) NOT NULL,
        training_charges DECIMAL(10, 2) NOT NULL,
        monthly_cost DECIMAL(10, 2) NOT NULL,
        daily_rate DECIMAL(10, 2) NOT NULL,
        hourly_rate DECIMAL(10, 2) NOT NULL,
        gst DECIMAL(10, 2) NOT NULL,
        grand_total DECIMAL(10, 2) NOT NULL,
        gross_salary DECIMAL(10, 2) NOT NULL,
        employee_pf DECIMAL(10, 2) NOT NULL,
        employee_esic DECIMAL(10, 2) NOT NULL,
        professional_tax DECIMAL(10, 2) NOT NULL,
        net_salary DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_quotations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quotation_number VARCHAR(100) UNIQUE NOT NULL,
        calculation_id UUID REFERENCES finance_commercial_calculations(id) ON DELETE SET NULL,
        customer_id UUID REFERENCES finance_customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        unit_code VARCHAR(50) NOT NULL,
        date DATE NOT NULL,
        validity DATE NOT NULL,
        prepared_by VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
        terms_conditions TEXT,
        total_monthly_cost DECIMAL(12, 2) NOT NULL DEFAULT 0,
        total_gst DECIMAL(12, 2) NOT NULL DEFAULT 0,
        total_grand_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_quotation_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quotation_id UUID NOT NULL REFERENCES finance_quotations(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        no_of_resources INT NOT NULL,
        monthly_rate DECIMAL(10, 2) NOT NULL,
        gst DECIMAL(10, 2) NOT NULL,
        grand_total DECIMAL(10, 2) NOT NULL,
        daily_rate DECIMAL(10, 2) NOT NULL,
        hourly_rate DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_rate_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        calculation_id UUID REFERENCES finance_commercial_calculations(id) ON DELETE SET NULL,
        customer_id UUID REFERENCES finance_customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        unit_code VARCHAR(50) NOT NULL,
        category VARCHAR(100) NOT NULL,
        monthly_rate DECIMAL(10, 2) NOT NULL,
        daily_rate DECIMAL(10, 2) NOT NULL,
        hourly_rate DECIMAL(10, 2) NOT NULL,
        effective_date DATE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_approval (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        calculation_id UUID NOT NULL REFERENCES finance_commercial_calculations(id) ON DELETE CASCADE,
        stage VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        comments TEXT,
        user_id UUID,
        user_name VARCHAR(255),
        approval_date TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS finance_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action VARCHAR(100) NOT NULL,
        module VARCHAR(100) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}',
        user_id UUID,
        user_name VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const countRows = await this.prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
      SELECT COUNT(*)::bigint as cnt FROM finance_wage_config
    `);
    if (Number(countRows[0]?.cnt || 0) === 0) {
      this.logger.log('Seeding initial finance_wage_config templates...');
      const defaultCats = [
        { cat: 'Security Guard', basic: 15000, da: 2000, hra: 1500, skilled: 1000 },
        { cat: 'Lady Guard', basic: 15000, da: 2000, hra: 1500, skilled: 1000 },
        { cat: 'Supervisor', basic: 18000, da: 2500, hra: 2000, skilled: 1500 },
        { cat: 'Security Officer', basic: 22000, da: 3000, hra: 2500, skilled: 2000 },
        { cat: 'Housekeeping', basic: 13500, da: 1500, hra: 1200, skilled: 500 },
        { cat: 'Driver', basic: 16000, da: 2200, hra: 1500, skilled: 1200 },
        { cat: 'Office Boy', basic: 13000, da: 1500, hra: 1000, skilled: 500 },
        { cat: 'Receptionist', basic: 17000, da: 2000, hra: 1800, skilled: 1000 },
        { cat: 'Technician', basic: 19000, da: 2500, hra: 2000, skilled: 1500 },
        { cat: 'Caregiver', basic: 16500, da: 2000, hra: 1500, skilled: 1200 },
        { cat: 'Nurse', basic: 24000, da: 3500, hra: 2500, skilled: 2500 },
        { cat: 'Cook', basic: 15500, da: 2000, hra: 1500, skilled: 1000 },
        { cat: 'Helper', basic: 12500, da: 1200, hra: 1000, skilled: 500 },
      ];
      for (const item of defaultCats) {
        await this.exec(`
          INSERT INTO finance_wage_config (
            state, zone, effective_date, category, basic_wage, da, hra, skilled_allowance,
            additional_hours_pct, employer_pf_pct, employer_pf_max, employee_pf_pct,
            employer_esic_pct, employee_esic_pct, bonus_pct, leave_days, lwf_pct, lwf_max,
            uniform_allowance, relieving_pct, management_pct, training_charges, gst_pct,
            professional_tax, nfh, status
          ) VALUES (
            'Delhi NCR', 'Zone A', CURRENT_DATE, '${item.cat}', ${item.basic}, ${item.da}, ${item.hra}, ${item.skilled},
            50, 12, 15000, 12, 3.25, 0.75, 8.33, 15, 0.2, 25, 500, 8.33, 10, 300, 18, 200, 300, 'ACTIVE'
          )
        `);
      }
    }

    this.logger.log('Commercial module tables verified.');
  }
}
