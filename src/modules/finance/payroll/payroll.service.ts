import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PayrollService as CorePayrollService } from '../../payroll/payroll.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');

interface PlacementRow {
  id: string;
  staff_id: string;
  client_id: string;
  staff_salary: string;
  management_fee: string;
  status: string;
  staff_name: string;
  staff_code: string;
  branch_id: string;
}

export interface PayrollRecordRow {
  id: string;
  placement_id: string;
  staff_id: string;
  period_month: number;
  period_year: number;
  shift_days: number;
  gross_salary: string;
  net_salary: string;
  esic_employer: string;
  esic_employee: string;
  pf_employer: string;
  pf_employee: string;
  deductions: Record<string, unknown>;
  disbursed_at: string | null;
  disbursement_ref: string | null;
  client_invoice_id: string | null;
  created_at: string;
  staff_name: string;
  staff_code: string;
}

@Injectable()
export class FinancePayrollService {
  private readonly logger = new Logger(FinancePayrollService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _razorpay: any;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly corePayroll: CorePayrollService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRazorpay(): any {
    if (!this._razorpay) {
      const keyId = this.config.get<string>('app.razorpay.keyId', '');
      const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
      if (!keyId || keyId.startsWith('YOUR_') || !keySecret || keySecret.startsWith('YOUR_')) {
        throw new Error('Razorpay credentials not configured.');
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      this._razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
    return this._razorpay;
  }

  /** List all payroll records for a given month/year */
  async listPayrollRuns(month?: number, year?: number): Promise<PayrollRecordRow[]> {
    let sql = `
      SELECT
        pr.*,
        sa.full_name  AS staff_name,
        sa.staff_code AS staff_code
      FROM payroll_records pr
      JOIN staff_applicants sa ON sa.id = pr.staff_id
    `;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (month) { params.push(month); conditions.push(`pr.period_month = $${params.length}`); }
    if (year)  { params.push(year);  conditions.push(`pr.period_year  = $${params.length}`); }
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY pr.created_at DESC';
    return this.dataSource.query<PayrollRecordRow[]>(sql, params);
  }

  /** Preview payroll calculation for a single placement without writing to DB */
  async previewPayroll(placementId: string, month: number, year: number) {
    const rows = await this.dataSource.query<PlacementRow[]>(
      `SELECT p.*, sa.full_name AS staff_name, sa.staff_code
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       WHERE p.id = $1`,
      [placementId],
    );
    if (!rows.length) throw new NotFoundException(`Placement ${placementId} not found`);
    const p = rows[0];

    const shiftRows = await this.dataSource.query<{ shift_days: string }[]>(
      `SELECT COUNT(*) AS shift_days FROM shift_logs
       WHERE placement_id = $1
         AND EXTRACT(MONTH FROM log_date) = $2
         AND EXTRACT(YEAR  FROM log_date) = $3
         AND status = 'PRESENT'`,
      [placementId, month, year],
    );
    const shiftDays = parseInt(shiftRows[0]?.shift_days ?? '0', 10);
    const calc = this.corePayroll.calculatePayroll(
      parseFloat(p.staff_salary),
      parseFloat(p.management_fee),
    );

    return {
      placement_id: placementId,
      staff_name: p.staff_name,
      staff_code: p.staff_code,
      period_month: month,
      period_year: year,
      shift_days: shiftDays,
      ...calc,
    };
  }

  /** Confirm and post payroll batch for ALL CONFIRMED placements in a given month/year */
  async confirmPayrollBatch(month: number, year: number) {
    // Check for existing batch
    const existing = await this.dataSource.query<{ cnt: string }[]>(
      `SELECT COUNT(*) AS cnt FROM payroll_records
       WHERE period_month = $1 AND period_year = $2`,
      [month, year],
    );
    if (parseInt(existing[0]?.cnt ?? '0', 10) > 0) {
      throw new BadRequestException(`Payroll batch for ${month}/${year} already confirmed`);
    }

    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT p.*, sa.full_name AS staff_name, sa.staff_code
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       WHERE p.status = 'CONFIRMED'`,
    );
    if (!placements.length) throw new BadRequestException('No confirmed placements found');

    const results = await Promise.all(placements.map(async (p) => {
      try {
        return await this.corePayroll.runMonthlyPayroll(p.id, month, year);
      } catch (e) {
        this.logger.warn(`[BATCH] Skipped placement ${p.id}: ${(e as Error).message}`);
        return null;
      }
    }));

    const processed = results.filter(Boolean);
    this.logger.log(`[PAYROLL_BATCH] Confirmed ${processed.length}/${placements.length} for ${month}/${year}`);
    return {
      month, year,
      total_placements: placements.length,
      processed: processed.length,
      skipped: placements.length - processed.length,
      records: processed,
    };
  }

  /** Trigger Razorpay disbursement for a specific payroll record */
  async triggerDisbursement(payrollId: string) {
    const rows = await this.dataSource.query<PayrollRecordRow[]>(
      `SELECT pr.*, sa.full_name AS staff_name FROM payroll_records pr
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE pr.id = $1`,
      [payrollId],
    );
    if (!rows.length) throw new NotFoundException(`Payroll record ${payrollId} not found`);
    const record = rows[0];
    if (record.disbursed_at) {
      throw new BadRequestException('Already disbursed: ' + record.disbursement_ref);
    }

    // Create a Razorpay order (actual payout requires Razorpay X account)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const order = await this.getRazorpay().orders.create({
      amount: Math.round(parseFloat(record.net_salary) * 100),
      currency: 'INR',
      receipt: payrollId,
      notes: { payrollId, staffName: record.staff_name },
    }) as Record<string, unknown>;

    const ref = order['id'] as string;
    await this.dataSource.query(
      `UPDATE payroll_records SET disbursed_at = NOW(), disbursement_ref = $1 WHERE id = $2`,
      [ref, payrollId],
    );
    return { payrollId, razorpay_order: order, disbursement_ref: ref };
  }
}
