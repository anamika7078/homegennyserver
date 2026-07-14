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
  type: 'PLACEMENT' | 'EMPLOYEE';
  placement_id: string | null;
  staff_id: string | null;
  employee_id: string | null;
  period_month: number;
  period_year: number;
  shift_days: number | null;
  present_days: number | null;
  gross_salary: string;
  net_salary: string;
  esic_employer: string | null;
  esic_employee: string | null;
  pf_employer: string | null;
  pf_employee: string | null;
  deductions: Record<string, unknown>;
  disbursed_at: string | null;
  disbursement_ref: string | null;
  client_invoice_id: string | null;
  created_at: string;
  staff_name: string;
  staff_code: string | null;
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

  /** List all payroll records for a given month/year (placement EOR + HR employee payrolls) */
  async listPayrollRuns(month?: number, year?: number): Promise<PayrollRecordRow[]> {
    try {
      const params: unknown[] = [];

      // Build WHERE clauses for month/year — we'll use the same param indices for both halves
      const monthIdx = month ? (params.push(month), params.length) : null;
      const yearIdx  = year  ? (params.push(year),  params.length) : null;

      const placementWhere = [
        monthIdx ? `pr.period_month = $${monthIdx}` : null,
        yearIdx  ? `pr.period_year  = $${yearIdx}`  : null,
      ].filter(Boolean).join(' AND ');

      const employeeWhere = [
        monthIdx ? `ep.period_month = $${monthIdx}` : null,
        yearIdx  ? `ep.period_year  = $${yearIdx}`  : null,
      ].filter(Boolean).join(' AND ');

      const sql = `
        -- EOR / placement payroll records
        SELECT
          pr.id,
          'PLACEMENT'           AS type,
          pr.placement_id,
          pr.staff_id,
          NULL::uuid            AS employee_id,
          pr.period_month,
          pr.period_year,
          pr.shift_days,
          NULL::numeric         AS present_days,
          pr.gross_salary,
          pr.net_salary,
          pr.esic_employer,
          pr.esic_employee,
          pr.pf_employer,
          pr.pf_employee,
          pr.deductions,
          pr.disbursed_at,
          pr.disbursement_ref,
          pr.client_invoice_id,
          pr.created_at,
          sa.full_name  AS staff_name,
          sa.staff_code AS staff_code
        FROM payroll_records pr
        JOIN staff_applicants sa ON sa.id = pr.staff_id
        ${placementWhere ? `WHERE ${placementWhere}` : ''}

        UNION ALL

        -- Internal employee payrolls (created by HR via attendance)
        SELECT
          ep.id,
          'EMPLOYEE'            AS type,
          NULL::uuid            AS placement_id,
          NULL::uuid            AS staff_id,
          ep.employee_id,
          ep.period_month,
          ep.period_year,
          NULL::integer         AS shift_days,
          ep.present_days,
          ep.gross_salary,
          ep.net_salary,
          NULL::numeric         AS esic_employer,
          NULL::numeric         AS esic_employee,
          NULL::numeric         AS pf_employer,
          NULL::numeric         AS pf_employee,
          ep.deductions,
          ep.disbursed_at,
          NULL::text            AS disbursement_ref,
          NULL::uuid            AS client_invoice_id,
          ep.created_at,
          e.full_name           AS staff_name,
          e.employee_id         AS staff_code
        FROM employee_payrolls ep
        JOIN employees e ON e.id = ep.employee_id
        ${employeeWhere ? `WHERE ${employeeWhere}` : ''}

        ORDER BY created_at DESC
      `;

      return this.dataSource.query<PayrollRecordRow[]>(sql, params);
    } catch (err) {
      this.logger.warn(`listPayrollRuns: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Resolve staff_code (EOR) or employee_id (internal HR) to a lookup record */
  async lookupByCode(code: string) {
    const trimmed = code?.trim();
    if (!trimmed) throw new BadRequestException('Employee code is required');

    const staffRows = await this.dataSource.query<{
      id: string;
      staff_code: string;
      full_name: string;
      placement_id: string | null;
      monthly_salary: string | null;
      client_name: string | null;
      placement_status: string | null;
    }[]>(
      `SELECT
         sa.id,
         sa.staff_code,
         sa.full_name,
         p.id AS placement_id,
         p.staff_salary AS monthly_salary,
         c.full_name AS client_name,
         p.status AS placement_status
       FROM staff_applicants sa
       LEFT JOIN LATERAL (
         SELECT id, staff_salary, status, client_id
         FROM placements
         WHERE staff_id = sa.id AND status = 'CONFIRMED'
         ORDER BY created_at DESC
         LIMIT 1
       ) p ON true
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE UPPER(sa.staff_code) = UPPER($1)
       LIMIT 1`,
      [trimmed],
    );

    if (staffRows.length) {
      const s = staffRows[0];
      return {
        type: 'PLACEMENT' as const,
        staff_id: s.id,
        staff_code: s.staff_code,
        staff_name: s.full_name,
        placement_id: s.placement_id,
        monthly_salary: s.monthly_salary ? parseFloat(s.monthly_salary) : null,
        client_name: s.client_name,
        placement_status: s.placement_status,
      };
    }

    const empRows = await this.dataSource.query<{
      id: string;
      employee_id: string;
      full_name: string;
      department: string | null;
      salary: string;
    }[]>(
      `SELECT id, employee_id, full_name, department, salary
       FROM employees
       WHERE UPPER(employee_id) = UPPER($1) AND UPPER(status) = 'ACTIVE'
       LIMIT 1`,
      [trimmed],
    );

    if (!empRows.length) {
      throw new NotFoundException(`No staff or employee found for code "${trimmed}"`);
    }

    const e = empRows[0];
    return {
      type: 'EMPLOYEE' as const,
      employee_id: e.id,
      employee_code: e.employee_id,
      staff_name: e.full_name,
      department: e.department,
      monthly_salary: parseFloat(e.salary),
    };
  }

  private async resolveCode(code: string) {
    return this.lookupByCode(code);
  }

  /** Preview attendance-based payroll / invoice for a staff or employee code */
  async previewAttendanceByCode(code: string, month: number, year: number) {
    const lookup = await this.resolveCode(code);

    if (lookup.type === 'PLACEMENT') {
      if (!lookup.placement_id) {
        throw new BadRequestException('Staff has no confirmed placement — cannot generate client invoice');
      }
      const preview = await this.corePayroll.previewAttendancePayroll(lookup.placement_id, month, year);
      const existing = await this.dataSource.query<{ id: string; invoice_number: string }[]>(
        `SELECT id, invoice_number FROM client_invoices
         WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
         LIMIT 1`,
        [lookup.placement_id, month, year],
      );
      return {
        ...preview,
        type: 'PLACEMENT',
        staff_code: lookup.staff_code,
        staff_name: lookup.staff_name,
        client_name: lookup.client_name,
        invoice_id: existing[0]?.id ?? null,
        invoice_number: existing[0]?.invoice_number ?? null,
      };
    }

    const preview = await this.corePayroll.previewEmployeePayroll(lookup.employee_id, month, year);
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM employee_payrolls
       WHERE employee_id = $1::uuid AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [lookup.employee_id, month, year],
    );
    return {
      ...preview,
      type: 'EMPLOYEE',
      staff_code: lookup.employee_code,
      staff_name: lookup.staff_name,
      department: lookup.department,
      payroll_id: existing[0]?.id ?? null,
    };
  }

  /** Generate attendance-based payroll record (+ client invoice for EOR staff) */
  async generateAttendanceByCode(code: string, month: number, year: number) {
    const lookup = await this.resolveCode(code);

    if (lookup.type === 'PLACEMENT') {
      if (!lookup.placement_id) {
        throw new BadRequestException('Staff has no confirmed placement');
      }
      const result = await this.corePayroll.runAttendancePayroll(lookup.placement_id, month, year);
      const invoice = result.invoice as Record<string, unknown>;
      return {
        type: 'PLACEMENT',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        payroll_id: (result.payroll as Record<string, unknown>).id,
        preview: result.preview,
        calculation: result.calculation,
        staff_code: lookup.staff_code,
        staff_name: lookup.staff_name,
      };
    }

    const result = await this.corePayroll.runEmployeePayroll(lookup.employee_id, month, year);
    return {
      type: 'EMPLOYEE',
      payroll_id: (result.payroll as Record<string, unknown>).id,
      preview: result.preview,
      staff_code: lookup.employee_code,
      staff_name: lookup.staff_name,
    };
  }

  /** Build downloadable HTML payslip / invoice from preview payload */
  buildPreviewHtml(preview: Record<string, unknown>): string {
    const type = preview.type as string;
    const calc = preview.calculation as Record<string, number> | undefined;
    const fmt = (n: unknown) =>
      new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
        .format(Number(n ?? 0));

    const rows: [string, string][] = [
      ['Employee Code', String(preview.staff_code ?? '')],
      ['Name', String(preview.staff_name ?? '')],
      ['Period', `${preview.period_month}/${preview.period_year}`],
      ['Monthly Salary', fmt(preview.monthly_salary)],
      [
        'Attendance',
        `${preview.billable_days} billable / ${preview.days_in_month} days`,
      ],
      ['Pro-rated Gross', fmt(preview.prorated_gross)],
    ];

    if (type === 'PLACEMENT' && calc) {
      rows.push(
        ['Management Fee', fmt(calc.managementFee)],
        ['GST on Fee (18%)', fmt(calc.gstOnFee)],
        ['ESIC (Employee)', fmt(calc.esicEmployee)],
        ['PF (Employee)', fmt(calc.pfEmployee)],
        ['Net Salary', fmt(calc.netSalary)],
        ['Client Total', fmt(calc.clientTotalCharge)],
      );
    } else if (calc) {
      rows.push(
        ['ESIC (Employee)', fmt(calc.esicEmployee)],
        ['PF (Employee)', fmt(calc.pfEmployee)],
        ['Net Payable', fmt(calc.netSalary)],
      );
    }

    const title = type === 'PLACEMENT' ? 'Monthly Payroll Invoice' : 'Monthly Payslip';
    const invoiceNo = preview.invoice_number ? `<p><strong>Invoice #:</strong> ${preview.invoice_number}</p>` : '';

    const bodyRows = rows
      .map(([k, v]) => `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#64748b">${k}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600">${v}</td></tr>`)
      .join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;color:#0f172a">
  <h1 style="margin:0 0 4px">HomeGenny</h1>
  <p style="margin:0 0 24px;color:#64748b">${title}</p>
  ${invoiceNo}
  <table style="width:100%;border-collapse:collapse">${bodyRows}</table>
  <p style="margin-top:32px;font-size:12px;color:#94a3b8">Generated ${new Date().toLocaleString('en-IN')}</p>
</body></html>`;
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
         AND EXTRACT(MONTH FROM shift_date) = $2
         AND EXTRACT(YEAR  FROM shift_date) = $3
         AND status = 'APPROVED'`,
      [placementId, month, year],
    );
    const shiftDays = parseInt(shiftRows[0]?.shift_days ?? '0', 10);
    const monthlySalary = parseFloat(p.staff_salary);
    const monthlyFee = parseFloat(p.management_fee);
    const dim = this.corePayroll.daysInMonth(month, year);
    const proratedGross = this.corePayroll.calculateProratedGross(monthlySalary, shiftDays, dim);
    const proratedFee = this.corePayroll.calculateProratedGross(monthlyFee, shiftDays, dim);
    const calc = this.corePayroll.calculatePayrollWithAbsoluteFee(proratedGross, proratedFee);

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

  /** Trigger Razorpay disbursement for a specific payroll record (placement OR employee) */
  async triggerDisbursement(payrollId: string) {
    // Try placement payroll first
    const placementRows = await this.dataSource.query<PayrollRecordRow[]>(
      `SELECT pr.*, sa.full_name AS staff_name, 'PLACEMENT' AS type
       FROM payroll_records pr
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE pr.id = $1`,
      [payrollId],
    );

    // Try employee payroll if not found in placement records
    const employeeRows = !placementRows.length
      ? await this.dataSource.query<PayrollRecordRow[]>(
          `SELECT ep.*, e.full_name AS staff_name, 'EMPLOYEE' AS type
           FROM employee_payrolls ep
           JOIN employees e ON e.id = ep.employee_id
           WHERE ep.id = $1`,
          [payrollId],
        )
      : [];

    const record = placementRows[0] ?? employeeRows[0];
    if (!record) throw new NotFoundException(`Payroll record ${payrollId} not found`);
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

    // Update the correct table
    const isEmployee = record.type === 'EMPLOYEE' || employeeRows.length > 0;
    if (isEmployee) {
      await this.dataSource.query(
        `UPDATE employee_payrolls SET disbursed_at = NOW() WHERE id = $1`,
        [payrollId],
      );
    } else {
      await this.dataSource.query(
        `UPDATE payroll_records SET disbursed_at = NOW(), disbursement_ref = $1 WHERE id = $2`,
        [ref, payrollId],
      );
    }

    return { payrollId, razorpay_order: order, disbursement_ref: ref };
  }
}
