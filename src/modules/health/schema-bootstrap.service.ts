import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Ensures module-critical tables exist on deployed DBs that skipped TypeORM / partial Prisma migrations. */
@Injectable()
export class SchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(SchemaBootstrapService.name);

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
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS training_batches (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_code   VARCHAR(40) UNIQUE NOT NULL,
        series       VARCHAR(10) NOT NULL,
        trainer_name VARCHAR(100),
        classroom    VARCHAR(80),
        start_date   DATE NOT NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'UPCOMING',
        branch_id    UUID,
        rm_id        UUID,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS batch_enrollments (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id   UUID NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
        staff_id   UUID NOT NULL REFERENCES staff_applicants(id),
        attendance INTEGER[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(batch_id, staff_id)
      );

      CREATE INDEX IF NOT EXISTS idx_training_batches_branch ON training_batches(branch_id);
      CREATE INDEX IF NOT EXISTS idx_batch_enrollments_batch ON batch_enrollments(batch_id);

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
      );

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
      );

      CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_records(period_year, period_month);
      CREATE INDEX IF NOT EXISTS idx_client_invoices_status ON client_invoices(status);
    `);
    this.logger.log('Module tables verified (training, finance)');
  }
}
