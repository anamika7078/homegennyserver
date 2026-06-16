import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1710000000001 implements MigrationInterface {
  name = 'InitialSchema1710000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // Enums
    await queryRunner.query(`
      CREATE TYPE staff_series AS ENUM ('MAID', 'SC', 'UC', 'DR');
      CREATE TYPE pipeline_stage AS ENUM (
        'S1_INTAKE','S2_VERIFY','S2_5_ASSESS','S3_TRAIN',
        'S4_AGREEMENTS','S5_DEPLOY','DEFERRED','TERMINAL'
      );
      CREATE TYPE terminal_outcome AS ENUM (
        'PLACED','REJECTED','ABANDONED','RESTRICTED','DEFERRED','CANCELLED','LATE_EXIT'
      );
      CREATE TYPE language_tier AS ENUM ('T1','T2','T3','T4');
      CREATE TYPE pv_status AS ENUM ('CLEAR','PENDING','FAILED','EXEMPT');
      CREATE TYPE placement_status AS ENUM ('TRIAL','CONFIRMED','EXITED','TERMINATED');
      CREATE TYPE user_role AS ENUM ('STAFF','CLIENT','RM','BM','FINANCE','ADMIN');
    `);

    // Branches
    await queryRunner.query(`
      CREATE TABLE branches (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        gstin VARCHAR(20),
        address TEXT,
        phone VARCHAR(20),
        email VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Users (all roles)
    await queryRunner.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        branch_id UUID REFERENCES branches(id),
        role user_role NOT NULL,
        full_name VARCHAR(200) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(200) UNIQUE,
        password_hash VARCHAR(255),
        refresh_token_hash VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        last_login_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Staff Applicants — core entity
    await queryRunner.query(`
      CREATE TABLE staff_applicants (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_code VARCHAR(20) UNIQUE NOT NULL,
        user_id UUID REFERENCES users(id),
        branch_id UUID NOT NULL REFERENCES branches(id),
        assigned_rm_id UUID REFERENCES users(id),
        series staff_series NOT NULL,
        role_types TEXT[] NOT NULL DEFAULT '{}',
        language_tier language_tier NOT NULL DEFAULT 'T3',
        pipeline_stage pipeline_stage NOT NULL DEFAULT 'S1_INTAKE',
        current_scenario_code VARCHAR(20),
        terminal_outcome terminal_outcome,
        terminal_reason TEXT,
        restrictions JSONB DEFAULT '{}',
        verified_docs JSONB DEFAULT '{}',
        pv_status pv_status DEFAULT 'PENDING',
        restricted_list_flag BOOLEAN DEFAULT false,
        video_cert_id UUID,
        deposit_amount DECIMAL(10,2) DEFAULT 0,
        deposit_paid BOOLEAN DEFAULT false,
        training_start_date DATE,
        training_end_date DATE,
        deployment_ready_date DATE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Pipeline Events — append-only audit log
    await queryRunner.query(`
      CREATE TABLE pipeline_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        event_type VARCHAR(100) NOT NULL,
        from_stage pipeline_stage,
        to_stage pipeline_stage,
        actor_id UUID REFERENCES users(id),
        scenario_code VARCHAR(20),
        reason_code VARCHAR(50),
        payload JSONB DEFAULT '{}',
        occurred_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Video Certifications
    await queryRunner.query(`
      CREATE TABLE video_certs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        series staff_series NOT NULL,
        prompt_set_version VARCHAR(20) NOT NULL,
        prompt_count INT NOT NULL,
        duration_seconds INT,
        storage_url TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        sha256_hash VARCHAR(64) NOT NULL UNIQUE,
        rm_signed_off BOOLEAN DEFAULT false,
        rm_id UUID REFERENCES users(id),
        rm_signed_at TIMESTAMPTZ,
        never_delete BOOLEAN DEFAULT false,
        retention_until DATE,
        attempt_number INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Placements
    await queryRunner.query(`
      CREATE TABLE placements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        client_id UUID NOT NULL REFERENCES users(id),
        branch_id UUID NOT NULL REFERENCES branches(id),
        rm_id UUID REFERENCES users(id),
        status placement_status NOT NULL DEFAULT 'TRIAL',
        exit_scenario_code VARCHAR(20),
        scope_of_work JSONB DEFAULT '{}',
        vehicle_condition_record_id UUID,
        trial_start_date DATE,
        trial_end_date DATE,
        billing_start_date DATE,
        exit_date DATE,
        staff_salary DECIMAL(10,2),
        management_fee DECIMAL(10,2),
        gst_on_fee DECIMAL(10,2),
        replacement_count INT DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Payroll Records
    await queryRunner.query(`
      CREATE TABLE payroll_records (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        placement_id UUID NOT NULL REFERENCES placements(id),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        period_month INT NOT NULL,
        period_year INT NOT NULL,
        shift_days INT NOT NULL DEFAULT 0,
        gross_salary DECIMAL(10,2) NOT NULL,
        deductions JSONB DEFAULT '{}',
        net_salary DECIMAL(10,2) NOT NULL,
        esic_employer DECIMAL(10,2) DEFAULT 0,
        esic_employee DECIMAL(10,2) DEFAULT 0,
        pf_employer DECIMAL(10,2) DEFAULT 0,
        pf_employee DECIMAL(10,2) DEFAULT 0,
        disbursed_at TIMESTAMPTZ,
        disbursement_ref VARCHAR(100),
        client_invoice_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Shift Logs
    await queryRunner.query(`
      CREATE TABLE shift_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        placement_id UUID NOT NULL REFERENCES placements(id),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        log_date DATE NOT NULL,
        check_in TIMESTAMPTZ,
        check_out TIMESTAMPTZ,
        hours_worked DECIMAL(4,2),
        status VARCHAR(20) DEFAULT 'PRESENT',
        notes TEXT,
        client_confirmed BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Client Invoices
    await queryRunner.query(`
      CREATE TABLE client_invoices (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        placement_id UUID NOT NULL REFERENCES placements(id),
        client_id UUID NOT NULL REFERENCES users(id),
        invoice_number VARCHAR(50) UNIQUE NOT NULL,
        period_month INT NOT NULL,
        period_year INT NOT NULL,
        staff_salary_component DECIMAL(10,2) NOT NULL,
        management_fee DECIMAL(10,2) NOT NULL,
        gst_amount DECIMAL(10,2) NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        due_date DATE NOT NULL,
        paid_at TIMESTAMPTZ,
        payment_ref VARCHAR(100),
        razorpay_order_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'PENDING',
        pdf_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Restricted List
    await queryRunner.query(`
      CREATE TABLE restricted_list (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_id UUID REFERENCES staff_applicants(id),
        aadhaar_hash VARCHAR(64),
        phone_hash VARCHAR(64),
        name VARCHAR(200),
        reason VARCHAR(100) NOT NULL,
        added_by UUID REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Upgrade Paths
    await queryRunner.query(`
      CREATE TABLE upgrade_paths (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        staff_id UUID NOT NULL REFERENCES staff_applicants(id),
        from_series staff_series NOT NULL,
        to_series staff_series NOT NULL,
        eligibility_date DATE,
        triggered_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'ELIGIBLE',
        notes TEXT
      )
    `);

    // ─── Indexes ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX idx_staff_pipeline_stage ON staff_applicants(pipeline_stage);
      CREATE INDEX idx_staff_branch ON staff_applicants(branch_id);
      CREATE INDEX idx_staff_rm ON staff_applicants(assigned_rm_id);
      CREATE INDEX idx_staff_series ON staff_applicants(series);
      CREATE INDEX idx_staff_restricted ON staff_applicants(restricted_list_flag) WHERE restricted_list_flag = true;
      CREATE INDEX idx_pipeline_events_staff ON pipeline_events(staff_id);
      CREATE INDEX idx_pipeline_events_time ON pipeline_events(occurred_at DESC);
      CREATE INDEX idx_video_cert_hash ON video_certs(sha256_hash);
      CREATE INDEX idx_video_cert_staff ON video_certs(staff_id);
      CREATE INDEX idx_video_never_delete ON video_certs(never_delete) WHERE never_delete = true;
      CREATE INDEX idx_placements_status ON placements(status);
      CREATE INDEX idx_placements_staff ON placements(staff_id);
      CREATE INDEX idx_placements_client ON placements(client_id);
      CREATE INDEX idx_payroll_period ON payroll_records(period_year, period_month);
      CREATE INDEX idx_shift_logs_date ON shift_logs(log_date);
      CREATE INDEX idx_restricted_aadhaar ON restricted_list(aadhaar_hash);
      CREATE INDEX idx_restricted_phone ON restricted_list(phone_hash);
      CREATE INDEX idx_upgrade_paths_staff ON upgrade_paths(staff_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS upgrade_paths CASCADE;
      DROP TABLE IF EXISTS restricted_list CASCADE;
      DROP TABLE IF EXISTS client_invoices CASCADE;
      DROP TABLE IF EXISTS shift_logs CASCADE;
      DROP TABLE IF EXISTS payroll_records CASCADE;
      DROP TABLE IF EXISTS placements CASCADE;
      DROP TABLE IF EXISTS video_certs CASCADE;
      DROP TABLE IF EXISTS pipeline_events CASCADE;
      DROP TABLE IF EXISTS staff_applicants CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS branches CASCADE;
      DROP TYPE IF EXISTS user_role;
      DROP TYPE IF EXISTS placement_status;
      DROP TYPE IF EXISTS pv_status;
      DROP TYPE IF EXISTS language_tier;
      DROP TYPE IF EXISTS terminal_outcome;
      DROP TYPE IF EXISTS pipeline_stage;
      DROP TYPE IF EXISTS staff_series;
    `);
  }
}
