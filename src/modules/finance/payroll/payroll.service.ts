import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PayrollService as CorePayrollService } from '../../payroll/payroll.service';
import { PayoutService, type PayoutResult } from './payout.service';

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
  /**
   * Where this record stands: PENDING until Finance approves it, then APPROVED,
   * and only then payable. The list left this out, so the screen read every
   * record as PENDING no matter how many times it was approved — the badge
   * stayed on "Needs approval" and the Approve button never went away.
   */
  status: string | null;
  disbursement_status: string | null;
  approved_at: string | null;
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

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly corePayroll: CorePayrollService,
    private readonly payouts: PayoutService,
  ) {}

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
          pr.status,
          pr.disbursement_status,
          pr.approved_at,
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
          ep.status,
          -- An internal employee payroll has no separate disbursement state or
          -- approval step; it is paid straight from HR.
          NULL::text            AS disbursement_status,
          NULL::timestamptz     AS approved_at,
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
         c.customer_name AS client_name,
         p.status AS placement_status
       FROM staff_applicants sa
       LEFT JOIN LATERAL (
         SELECT id, staff_salary, status, client_id
         FROM placements
         WHERE staff_id = sa.id AND status = 'CONFIRMED'
         ORDER BY created_at DESC
         LIMIT 1
       ) p ON true
       -- placements.client_id is a finance_customers id, not a legacy
       -- clients id — see invoice.service.ts getInvoice().
       LEFT JOIN finance_customers c ON c.id = p.client_id
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

    // An HR employee code resolves to the same person — every employee is a
    // pipeline candidate onboarded at S5_DEPLOY (§B4), so their payroll runs
    // on their placement like everyone else's. This join is what retires the
    // second payroll engine: there is no separate EMPLOYEE path any more.
    // See ONE_STAFF_MODEL_PLAN.md §B6.
    const empRows = await this.dataSource.query<{
      id: string;
      employee_id: string;
      full_name: string;
      department: string | null;
      salary: string;
      staff_applicant_id: string | null;
      staff_code: string | null;
      placement_id: string | null;
      monthly_salary: string | null;
      client_name: string | null;
      placement_status: string | null;
    }[]>(
      `SELECT e.id, e.employee_id, e.full_name, e.department, e.salary,
              e.staff_applicant_id,
              sa.staff_code,
              p.id AS placement_id,
              p.staff_salary AS monthly_salary,
              c.customer_name AS client_name,
              p.status AS placement_status
         FROM employees e
         LEFT JOIN staff_applicants sa ON sa.id = e.staff_applicant_id
         LEFT JOIN LATERAL (
           SELECT id, staff_salary, status, client_id
             FROM placements
            WHERE staff_id = sa.id AND status = 'CONFIRMED'
            ORDER BY created_at DESC
            LIMIT 1
         ) p ON true
         LEFT JOIN finance_customers c ON c.id = p.client_id
        WHERE UPPER(e.employee_id) = UPPER($1) AND UPPER(e.status) = 'ACTIVE'
        LIMIT 1`,
      [trimmed],
    );

    if (!empRows.length) {
      throw new NotFoundException(`No staff or employee found for code "${trimmed}"`);
    }

    const e = empRows[0];
    if (!e.staff_applicant_id) {
      throw new BadRequestException(
        `Employee ${e.employee_id} is not linked to a pipeline candidate, so there is ` +
          `no placement to bill against. Onboard them from the pipeline instead.`,
      );
    }

    return {
      type: 'PLACEMENT' as const,
      staff_id: e.staff_applicant_id,
      staff_code: e.staff_code ?? e.employee_id,
      staff_name: e.full_name,
      placement_id: e.placement_id,
      monthly_salary: e.monthly_salary ? parseFloat(e.monthly_salary) : parseFloat(e.salary),
      client_name: e.client_name,
      placement_status: e.placement_status,
    };
  }

  private async resolveCode(code: string) {
    return this.lookupByCode(code);
  }

  /**
   * Every house this staff member currently works at.
   *
   * `lookupByCode` takes the most recent confirmed placement and stops, which
   * was right while a person could only hold one. A maid working three houses
   * has three, and running payroll for her means running all three — picking
   * one silently left two clients unbilled and their staff member unpaid for
   * that work. See docs/HOURLY_MULTI_CLIENT_PLAN.md §B4.
   */
  private async activePlacementsFor(staffId: string) {
    return this.dataSource.query<{
      id: string; client_name: string | null; placement_type: string;
    }[]>(
      `SELECT p.id, c.customer_name AS client_name,
              COALESCE(p.placement_type, 'PERMANENT') AS placement_type
         FROM placements p
         LEFT JOIN finance_customers c ON c.id = p.client_id
        WHERE p.staff_id = $1 AND p.status = 'CONFIRMED'
        ORDER BY c.customer_name`,
      [staffId],
    );
  }

  /** Preview attendance-based payroll / invoice for a staff or employee code */
  async previewAttendanceByCode(code: string, month: number, year: number) {
    const lookup = await this.resolveCode(code);

    if (lookup.type === 'PLACEMENT') {
      if (!lookup.placement_id) {
        throw new BadRequestException('Staff has no confirmed placement — cannot generate client invoice');
      }
      const preview = await this.corePayroll.previewAttendancePayroll(lookup.placement_id, month, year);
      // "Has this already been run?" is answered by payroll, not by the
      // invoice: a consolidated invoice covers a whole client and leaves
      // placement_id NULL, so the old lookup on client_invoices.placement_id
      // always came back empty. The invoice reported here is the *client's*
      // invoice this payroll was billed on. See ONE_STAFF_MODEL_PLAN.md §B6.
      const existing = await this.dataSource.query<
        { id: string; invoice_id: string | null; invoice_number: string | null }[]
      >(
        `SELECT pr.id, ci.id AS invoice_id, ci.invoice_number
           FROM payroll_records pr
           LEFT JOIN client_invoices ci ON ci.id = pr.client_invoice_id
          WHERE pr.placement_id = $1 AND pr.period_month = $2 AND pr.period_year = $3
          LIMIT 1`,
        [lookup.placement_id, month, year],
      );
      // Generating runs every house she works at, so the preview has to show
      // every house too — previewing one and billing three is the mismatch
      // that makes a preview worse than none. See §B4.
      const placements = await this.activePlacementsFor(lookup.staff_id);
      const perPlacement = placements.length > 1
        ? await Promise.all(
            placements.map(async (p) => {
              const pv = await this.corePayroll.previewAttendancePayroll(p.id, month, year);
              const run = await this.dataSource.query<{ id: string }[]>(
                `SELECT id FROM payroll_records
                  WHERE placement_id = $1 AND period_month = $2 AND period_year = $3 LIMIT 1`,
                [p.id, month, year],
              );
              return {
                placement_id: p.id,
                client_name: p.client_name,
                placement_type: p.placement_type,
                already_run: run.length > 0,
                preview: pv,
              };
            }),
          )
        : undefined;

      return {
        ...preview,
        type: 'PLACEMENT',
        staff_code: lookup.staff_code,
        staff_name: lookup.staff_name,
        client_name: lookup.client_name,
        payroll_id: existing[0]?.id ?? null,
        invoice_id: existing[0]?.invoice_id ?? null,
        invoice_number: existing[0]?.invoice_number ?? null,
        /** Present only when she works at more than one house. */
        placements: perPlacement,
      };
    }

    // There is no second branch any more: lookupByCode resolves an employee
    // code through their pipeline candidate to the same placement, so every
    // code arrives here as a PLACEMENT. See ONE_STAFF_MODEL_PLAN.md §B6.
    throw new BadRequestException(
      `${code} has no confirmed placement, so there is nothing to bill for ${month}/${year}.`,
    );
  }

  /**
   * Run one staff member's payroll and fold it into their client's invoice.
   *
   * The invoice returned is the *client's* invoice for the period, which this
   * person has been added to — not an invoice for them alone. It can be null
   * when that invoice has already been sent and so cannot be amended; the
   * payroll is recorded either way. See ONE_STAFF_MODEL_PLAN.md §B3.
   *
   * Every house she works at is run, not the most recent one. Running a single
   * placement left the other clients unbilled and her unpaid for that work,
   * with nothing on screen to say so. A house whose payroll has already run is
   * skipped rather than failing the whole call — someone joining a second
   * client mid-month must not be blocked by the first one already being done.
   * See docs/HOURLY_MULTI_CLIENT_PLAN.md §B4.
   */
  async generateAttendanceByCode(code: string, month: number, year: number) {
    const lookup = await this.resolveCode(code);

    if (!lookup.placement_id) {
      throw new BadRequestException(
        `${code} has no confirmed placement, so there is nothing to bill for ${month}/${year}.`,
      );
    }

    const placements = await this.activePlacementsFor(lookup.staff_id);
    const runs: Record<string, unknown>[] = [];
    const skipped: { client_name: string | null; reason: string }[] = [];

    for (const p of placements) {
      try {
        const result = await this.corePayroll.runAttendancePayroll(p.id, month, year);
        runs.push({
          placement_id: p.id,
          client_name: p.client_name,
          placement_type: p.placement_type,
          payroll_id: (result.payroll as Record<string, unknown>).id,
          preview: result.preview,
          calculation: result.calculation,
        });
      } catch (e) {
        skipped.push({ client_name: p.client_name, reason: (e as Error).message });
      }
    }

    if (!runs.length) {
      // Nothing ran at all — the caller asked for work that cannot be done, so
      // this is a failure rather than an empty success.
      throw new BadRequestException(
        skipped.map((s) => `${s.client_name ?? 'client'}: ${s.reason}`).join('; ') ||
          `Nothing to run for ${code} in ${month}/${year}.`,
      );
    }

    // The top-level fields describe the first house, so a caller that only
    // knows about one placement still reads something true.
    const first = runs[0];
    return {
      type: 'PLACEMENT',
      // No invoice comes back from payroll. Payroll works out what is owed;
      // Finance raises the client's invoice from their unit code afterwards,
      // and it lands as a DRAFT to be looked at before it goes anywhere.
      payroll_id: first.payroll_id,
      preview: first.preview,
      calculation: first.calculation,
      staff_code: lookup.staff_code,
      staff_name: lookup.staff_name,
      /** One entry per house that was run this call. */
      runs,
      /** Houses that could not be run, and why — usually already run. */
      skipped,
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

  /**
   * Run payroll for every confirmed placement that has not been paid yet for
   * the period.
   *
   * This used to refuse outright if *anyone* had already been paid that month,
   * which made a whole month un-runnable the moment one person was processed —
   * and staff are placed mid-month all the time. It now works on who is left,
   * and the per-placement duplicate guard still stops anyone being paid twice.
   */
  async confirmPayrollBatch(month: number, year: number) {
    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT p.*, sa.full_name AS staff_name, sa.staff_code
         FROM placements p
         JOIN staff_applicants sa ON sa.id = p.staff_id
        WHERE p.status = 'CONFIRMED'
          AND NOT EXISTS (
            SELECT 1 FROM payroll_records pr
             WHERE pr.placement_id = p.id
               AND pr.period_month = $1 AND pr.period_year = $2
          )`,
      [month, year],
    );
    if (!placements.length) {
      const done = await this.dataSource.query<{ cnt: string }[]>(
        `SELECT COUNT(*) AS cnt FROM payroll_records
          WHERE period_month = $1 AND period_year = $2`,
        [month, year],
      );
      const already = parseInt(done[0]?.cnt ?? '0', 10);
      throw new BadRequestException(
        already > 0
          ? `Everyone has already been paid for ${month}/${year} — ${already} payroll record(s).`
          : 'No confirmed placements found.',
      );
    }

    // One payroll path, one attendance ledger. This used to call
    // runMonthlyPayroll, which counted approved `shift_logs` — the raw app
    // check-ins — while every other route counted `staff_daily_attendance`,
    // the ledger both the app and HR's screen mirror into. The same person and
    // month could come out with two different salaries depending on which
    // route ran. See ONE_STAFF_MODEL_PLAN.md §B6.
    const results = await Promise.all(placements.map(async (p) => {
      try {
        return await this.corePayroll.runAttendancePayroll(p.id, month, year);
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

  /**
   * Approves an EOR payroll record, which is what makes it payable.
   *
   * The EOR path had no approval step at all — a cron or a single POST wrote
   * straight to the database and disbursement would pay whatever was there.
   * See F-12.
   */
  async approvePayrollRecord(payrollId: string, actorId?: string) {
    const rows = await this.dataSource.query<{ id: string; status: string; net_salary: string }[]>(
      `SELECT id, status, net_salary FROM payroll_records WHERE id = $1`, [payrollId],
    );
    if (!rows.length) throw new NotFoundException(`Payroll record ${payrollId} not found`);

    const current = rows[0].status ?? 'PENDING';
    if (current !== 'PENDING') {
      throw new BadRequestException(
        `Payroll ${payrollId} is ${current}; only a PENDING record can be approved.`,
      );
    }

    const [updated] = await this.dataSource.query<Record<string, unknown>[]>(
      `UPDATE payroll_records
       SET status = 'APPROVED', approved_by = $1, approved_at = NOW(), locked_at = NOW()
       WHERE id = $2 RETURNING *`,
      [actorId ?? null, payrollId],
    );
    this.logger.log(`[PAYROLL_APPROVE] ${payrollId} approved by ${actorId ?? 'unknown'}`);
    return updated;
  }

  /**
   * Pays one payroll record out to the staff member's bank account.
   *
   * Three things changed here (F-09):
   *  - it uses RazorpayX Payouts, not Orders. An Order collects money from a
   *    customer; it never moved a rupee toward the staff member.
   *  - `disbursed_at` is only stamped when money actually moved. A simulated
   *    run is recorded as SIMULATED, so nothing downstream reads it as paid.
   *  - it refuses without bank details rather than "succeeding" with nowhere
   *    to send the money.
   *
   * And one from F-12: an unapproved payroll cannot be paid.
   */
  async triggerDisbursement(payrollId: string, actorId?: string) {
    const placementRows = await this.dataSource.query<(PayrollRecordRow & {
      status: string; disbursement_status: string; staff_code: string;
      account_holder_name: string | null; account_number: string | null; ifsc: string | null;
      razorpay_contact_id: string | null; razorpay_fund_account_id: string | null;
      bank_account_id: string | null;
    })[]>(
      `SELECT pr.*, sa.full_name AS staff_name, sa.staff_code, 'PLACEMENT' AS type,
              b.id AS bank_account_id, b.account_holder_name, b.account_number, b.ifsc,
              b.razorpay_contact_id, b.razorpay_fund_account_id
       FROM payroll_records pr
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       LEFT JOIN staff_bank_accounts b ON b.staff_id = pr.staff_id
       WHERE pr.id = $1`,
      [payrollId],
    );

    const employeeRows = !placementRows.length
      ? await this.dataSource.query<PayrollRecordRow[]>(
          `SELECT ep.*, e.full_name AS staff_name, 'EMPLOYEE' AS type
           FROM employee_payrolls ep
           JOIN employees e ON e.id = ep.employee_id
           WHERE ep.id = $1`,
          [payrollId],
        )
      : [];

    const record = (placementRows[0] ?? employeeRows[0]) as (PayrollRecordRow & Record<string, any>) | undefined;
    if (!record) throw new NotFoundException(`Payroll record ${payrollId} not found`);
    if (record.disbursed_at) {
      throw new BadRequestException(`Already disbursed (${record.disbursement_ref ?? 'no reference'}).`);
    }

    const isEmployee = employeeRows.length > 0;
    const amount = parseFloat(record.net_salary);
    if (!(amount > 0)) {
      throw new BadRequestException('Net salary is not a positive amount — nothing to disburse.');
    }

    // ── F-12 gate ────────────────────────────────────────────────────────────
    if (!isEmployee && record.status !== 'APPROVED') {
      throw new BadRequestException(
        `Payroll ${payrollId} is ${record.status ?? 'PENDING'}. Approve it before disbursing.`,
      );
    }

    // ── F-09: refuse rather than pay into nowhere ────────────────────────────
    if (!isEmployee && !record.account_number) {
      throw new BadRequestException(
        `No bank account on file for ${record.staff_code ?? 'this staff member'}. ` +
        `Add one via POST /finance/payroll/staff/${record.staff_id}/bank-account before disbursing.`,
      );
    }

    let result: PayoutResult;
    try {
      result = await this.payouts.payout({
        payrollId,
        staffName: record.staff_name,
        staffRef: record.staff_code ?? payrollId,
        amount,
        narration: 'HomeGenny Salary',
        bank: {
          accountHolderName: record.account_holder_name ?? record.staff_name,
          accountNumber: record.account_number ?? '',
          ifsc: record.ifsc ?? '',
          razorpayContactId: record.razorpay_contact_id,
          razorpayFundAccountId: record.razorpay_fund_account_id,
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!isEmployee) {
        await this.dataSource.query(
          `UPDATE payroll_records
           SET status = 'FAILED', disbursement_status = 'FAILED', disbursement_failure_reason = $1
           WHERE id = $2`,
          [reason, payrollId],
        );
      }
      throw err;
    }

    // Only a genuinely settled payout stamps disbursed_at. PROCESSING and
    // SIMULATED leave it null, so "has this person been paid?" stays honest.
    const settled = result.status === 'PAID';

    if (isEmployee) {
      await this.dataSource.query(
        `UPDATE employee_payrolls SET disbursed_at = ${settled ? 'NOW()' : 'NULL'}, status = $1 WHERE id = $2`,
        [settled ? 'PAID' : 'APPROVED', payrollId],
      );
    } else {
      await this.dataSource.query(
        `UPDATE payroll_records
         SET disbursement_status = $1,
             disbursement_ref = $2,
             status = $3,
             disbursed_at = ${settled ? 'NOW()' : 'disbursed_at'},
             disbursement_failure_reason = NULL
         WHERE id = $4`,
        [result.status, result.reference, settled ? 'PAID' : 'APPROVED', payrollId],
      );

      // Cache the RazorpayX ids so later payouts skip contact/fund-account creation.
      if (result.contactId && result.fundAccountId && record.bank_account_id) {
        await this.dataSource.query(
          `UPDATE staff_bank_accounts
           SET razorpay_contact_id = $1, razorpay_fund_account_id = $2, updated_at = NOW()
           WHERE id = $3`,
          [result.contactId, result.fundAccountId, record.bank_account_id],
        ).catch(() => undefined);
      }
    }

    this.logger.log(`[DISBURSEMENT] ${payrollId} → ${result.status} (${result.reference}) by ${actorId ?? 'unknown'}`);

    return {
      payrollId,
      disbursement_status: result.status,
      disbursement_ref: result.reference,
      settled,
      // Says plainly why no money moved, instead of returning a fake order.
      note: result.status === 'SIMULATED' ? this.payouts.configurationHint() : undefined,
    };
  }

  // ── Staff bank accounts (F-09) ────────────────────────────────────────────

  /** Never returns a full account number — only enough to recognise it. */
  async getStaffBankAccount(staffId: string) {
    const rows = await this.dataSource.query<{
      id: string; account_holder_name: string; account_number: string; ifsc: string;
      bank_name: string | null; is_verified: boolean; verified_at: string | null;
    }[]>(
      `SELECT id, account_holder_name, account_number, ifsc, bank_name, is_verified, verified_at
       FROM staff_bank_accounts WHERE staff_id = $1`,
      [staffId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      account_holder_name: r.account_holder_name,
      account_number_masked: `••••${r.account_number.slice(-4)}`,
      ifsc: r.ifsc,
      bank_name: r.bank_name,
      is_verified: r.is_verified,
      verified_at: r.verified_at,
    };
  }

  async upsertStaffBankAccount(
    staffId: string,
    body: { account_holder_name: string; account_number: string; ifsc: string; bank_name?: string },
    actorId?: string,
  ) {
    const accountNumber = String(body.account_number ?? '').replace(/\s/g, '');
    const ifsc = String(body.ifsc ?? '').trim().toUpperCase();

    if (!body.account_holder_name?.trim()) {
      throw new BadRequestException('Account holder name is required.');
    }
    if (!/^\d{6,20}$/.test(accountNumber)) {
      throw new BadRequestException('Account number must be 6–20 digits.');
    }
    // Standard IFSC shape: 4 letters, a 0, then 6 alphanumerics. Catching this
    // here beats discovering it when a payout bounces.
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new BadRequestException('IFSC must look like ABCD0123456.');
    }

    const staff = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM staff_applicants WHERE id = $1`, [staffId],
    );
    if (!staff.length) throw new NotFoundException(`Staff ${staffId} not found`);

    // Changing the destination invalidates the cached RazorpayX fund account,
    // which is bound to the old bank details.
    await this.dataSource.query(
      `INSERT INTO staff_bank_accounts
         (id, staff_id, account_holder_name, account_number, ifsc, bank_name, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (staff_id) DO UPDATE
       SET account_holder_name = EXCLUDED.account_holder_name,
           account_number = EXCLUDED.account_number,
           ifsc = EXCLUDED.ifsc,
           bank_name = EXCLUDED.bank_name,
           razorpay_fund_account_id = NULL,
           is_verified = false,
           verified_at = NULL,
           updated_at = NOW()`,
      [staffId, body.account_holder_name.trim(), accountNumber, ifsc, body.bank_name?.trim() ?? null, actorId ?? null],
    );

    return this.getStaffBankAccount(staffId);
  }

  /** Whether the payout rail is live, for the UI to show before anyone clicks. */
  payoutReadiness() {
    const configured = this.payouts.isConfigured();
    return { configured, hint: configured ? null : this.payouts.configurationHint() };
  }
}
