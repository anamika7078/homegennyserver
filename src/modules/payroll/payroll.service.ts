import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  calculateGstOnFee,
  calculateEsic,
  calculatePfFlat,
  calculateNetSalary,
  calculateClientTotal,
  round2,
  GST_RATE_DEFAULT,
  ESIC_EMPLOYEE_RATE_DEFAULT,
  ESIC_EMPLOYER_RATE_DEFAULT,
  PF_RATE_DEFAULT,
  PF_WAGE_CEILING,
} from '../../common/finance/statutory-calc.util';
import { StatutoryTaxService } from '../finance/tax/statutory-tax.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');

// Statutory rate constants now live in ../../common/finance/statutory-calc.util.ts
// — this file's calculatePayroll*() was the audit-confirmed baseline
// implementation, so the shared constants were extracted from here, not
// invented, and this service now delegates to them instead of holding its
// own copy (so commercial/enterprise-payroll/esic services can't quietly
// diverge from it again).

export interface PayrollCalculation {
  grossSalary: number;
  esicEmployee: number;
  esicEmployer: number;
  pfEmployee: number;
  pfEmployer: number;
  netSalary: number;
  managementFee: number;
  gstOnFee: number;
  clientTotalCharge: number;
  /** Rates actually applied — falls back to statutory defaults when the placement has no wage_config. */
  ratesUsed: {
    pfEmployeePct: number;
    pfEmployerPct: number;
    pfCeiling: number;
    esicEmployeePct: number;
    esicEmployerPct: number;
    gstPct: number;
  };
}

/** Subset of a placement's stored wage_config (see wage-calculator.util.ts) relevant to statutory calc. */
interface WageConfigRates {
  employer_pf_pct?: number;
  employee_pf_pct?: number;
  employer_pf_max?: number;
  employer_esic_pct?: number;
  employee_esic_pct?: number;
  gst_pct?: number;
}

interface PlacementRow {
  staff_id: string;
  client_id: string;
  staff_salary: string;
  management_fee: string;
  metadata?: unknown;
}

/**
 * Placement.metadata is `{ wage_config?, wage_breakup? }` when the RM used
 * the wage-breakup form (placement.service.ts's resolveWageTerms) instead of
 * typing a flat staff_salary/management_fee — this pulls the PF/ESIC/GST
 * rates RM actually configured back out, so the monthly attendance payroll
 * uses THOSE rates instead of silently falling back to statutory defaults
 * for every placement regardless of what was agreed with the client.
 */
function ratesFromPlacementMetadata(metadata: unknown): WageConfigRates | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const wageConfig = (metadata as { wage_config?: WageConfigRates }).wage_config;
  return wageConfig && typeof wageConfig === 'object' ? wageConfig : undefined;
}

/**
 * The PF base agreed for this placement, if the RM used the wage-breakup form.
 *
 * `wage_breakup.pfBase` is the figure the commercial calculator quoted the
 * client (basic + skilled allowance + leave wages). Deducting PF on gross
 * instead meant payroll charged a different number from the one agreed with
 * the client for the same person. See F-20. A placement without a breakup has
 * an undifferentiated wage, so there is no separate base and the caller
 * correctly falls back to gross.
 */
function pfBaseFromPlacementMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const breakup = (metadata as { wage_breakup?: Record<string, unknown> }).wage_breakup;
  if (!breakup || typeof breakup !== 'object') return null;
  const raw = breakup.pfBase;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface ShiftCountRow { shift_days: string; }

interface AttendanceCountRow { status: string; count: string; }

export interface AttendanceSummary {
  present_days: number;
  absent_days: number;
  leave_days: number;
  overtime_days: number;
  billable_days: number;
  days_in_month: number;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _razorpay: any;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly tax: StatutoryTaxService,
  ) {
    // Razorpay is initialised lazily in getRazorpay() so that the module
    // boots cleanly in dev even when credentials are placeholders.
  }

  /** Lazily create the Razorpay client — only throws when actually used. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRazorpay(): any {
    if (!this._razorpay) {
      const keyId = this.config.get<string>('app.razorpay.keyId', '');
      const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
      if (!keyId || keyId.startsWith('YOUR_') || !keySecret || keySecret.startsWith('YOUR_')) {
        throw new Error(
          'Razorpay credentials are not configured. ' +
          'Check your environment variables for app.razorpay.keyId and app.razorpay.keySecret.',
        );
      }
      // Razorpay uses CommonJS exports — require() avoids the default-import interop issue
      this._razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
    return this._razorpay;
  }

  /**
   * Demo batch queue — logs intent; extend with DB / job queue in production.
   */
  queuePayrollBatch(month: number, year: number, series?: string): {
    staff_count: number;
    total_inr: number;
    message: string;
    razorpay_scheduled: boolean;
  } {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const label = `${monthNames[month - 1] ?? 'Month'} ${year}`;
    const staffCount = 14;
    const totalInr = 328000;
    const totalFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(totalInr);
    this.logger.log(
      `[PAYROLL_QUEUE] ${label} series=${series ?? 'ALL'} staff=${staffCount} total=₹${totalFmt}`,
    );
    return {
      staff_count: staffCount,
      total_inr: totalInr,
      razorpay_scheduled: true,
      message: `${label} payroll batch queued — ${staffCount} staff · ₹${totalFmt} total · Razorpay disbursement scheduled`,
    };
  }

  daysInMonth(month: number, year: number): number {
    return new Date(year, month, 0).getDate();
  }

  calculateProratedGross(monthlySalary: number, billableDays: number, daysInMonth: number): number {
    if (daysInMonth <= 0) return 0;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return r2(monthlySalary * (billableDays / daysInMonth));
  }

  summarizeAttendanceCounts(rows: AttendanceCountRow[], month: number, year: number): AttendanceSummary {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = parseInt(row.count, 10);
    }
    const present_days = counts.PRESENT ?? 0;
    const absent_days = counts.ABSENT ?? 0;
    const leave_days = counts.LEAVE ?? 0;
    const overtime_days = counts.OVERTIME ?? 0;
    return {
      present_days,
      absent_days,
      leave_days,
      overtime_days,
      billable_days: present_days + overtime_days,
      days_in_month: this.daysInMonth(month, year),
    };
  }

  /**
   * @param pfBase The base PF is computed on. Defaults to gross, which is
   *               correct only when the wage carries no separately agreed
   *               base — see pfBaseFromPlacementMetadata and F-20.
   */
  calculatePayrollWithAbsoluteFee(
    grossSalary: number,
    managementFee: number,
    rates?: WageConfigRates,
    pfBase?: number,
  ): PayrollCalculation {
    const esic = calculateEsic(grossSalary, rates?.employee_esic_pct, rates?.employer_esic_pct);
    const pf = calculatePfFlat(pfBase ?? grossSalary, rates?.employee_pf_pct, rates?.employer_pf_pct, rates?.employer_pf_max);
    const netSalary = calculateNetSalary(grossSalary, esic.employee, pf.employee);
    const gstOnFee = calculateGstOnFee(managementFee, rates?.gst_pct);
    const clientTotalCharge = calculateClientTotal(grossSalary, esic.employer, pf.employer, managementFee, gstOnFee);

    return {
      grossSalary,
      esicEmployee: esic.employee,
      esicEmployer: esic.employer,
      pfEmployee: pf.employee,
      pfEmployer: pf.employer,
      netSalary,
      managementFee: round2(managementFee),
      gstOnFee,
      clientTotalCharge,
      ratesUsed: {
        pfEmployeePct: rates?.employee_pf_pct ?? PF_RATE_DEFAULT,
        pfEmployerPct: rates?.employer_pf_pct ?? rates?.employee_pf_pct ?? PF_RATE_DEFAULT,
        pfCeiling: rates?.employer_pf_max ?? PF_WAGE_CEILING,
        esicEmployeePct: rates?.employee_esic_pct ?? ESIC_EMPLOYEE_RATE_DEFAULT,
        esicEmployerPct: rates?.employer_esic_pct ?? ESIC_EMPLOYER_RATE_DEFAULT,
        gstPct: rates?.gst_pct ?? GST_RATE_DEFAULT,
      },
    };
  }

  /**
   * Defense-in-depth: placement.service.ts now blocks confirm() unless both
   * fields are set, but this guards against pre-existing bad data (3
   * CONFIRMED placements found with NULL salary/fee) and any other path that
   * might still produce it. Without this, parseFloat(null) = NaN sails
   * through every downstream calculation and Postgres NUMERIC happily
   * accepts the literal string 'NaN' into payroll_records/client_invoices
   * instead of the insert failing — confirmed live, this is not theoretical.
   */
  private assertValidSalaryTerms(monthlySalary: number, monthlyFee: number, placementId: string): void {
    if (isNaN(monthlySalary) || isNaN(monthlyFee)) {
      throw new BadRequestException(
        `Placement ${placementId} has no staff_salary/management_fee set — ` +
        `update it via PATCH /placements/${placementId}/terms before running payroll.`,
      );
    }
  }

  calculatePayroll(grossSalary: number, managementFeePercent: number): PayrollCalculation {
    const esic = calculateEsic(grossSalary);
    const pf = calculatePfFlat(grossSalary);
    const netSalary = calculateNetSalary(grossSalary, esic.employee, pf.employee);
    const managementFee = round2(grossSalary * (managementFeePercent / 100));
    const gstOnFee = calculateGstOnFee(managementFee);
    const clientTotalCharge = calculateClientTotal(grossSalary, esic.employer, pf.employer, managementFee, gstOnFee);

    return {
      grossSalary, esicEmployee: esic.employee, esicEmployer: esic.employer,
      pfEmployee: pf.employee, pfEmployer: pf.employer, netSalary,
      managementFee, gstOnFee, clientTotalCharge,
      ratesUsed: {
        pfEmployeePct: PF_RATE_DEFAULT,
        pfEmployerPct: PF_RATE_DEFAULT,
        pfCeiling: PF_WAGE_CEILING,
        esicEmployeePct: ESIC_EMPLOYEE_RATE_DEFAULT,
        esicEmployerPct: ESIC_EMPLOYER_RATE_DEFAULT,
        gstPct: GST_RATE_DEFAULT,
      },
    };
  }

  /**
   * Writes the client invoice and its line items together.
   *
   * Both payroll paths used to inline their own near-identical INSERT, which
   * is how they drifted apart before (one had a duplicate guard, the other
   * didn't). More importantly, neither stored employer ESIC/PF nor wrote any
   * `invoice_items` at all — so the four line items the invoice rendered
   * summed to less than the total it charged, with the employer
   * contributions unexplained. See F-03 in docs/FINANCE_MODULE_AUDIT.md.
   */
  private async insertInvoiceWithItems(
    manager: { query: <T>(sql: string, params?: unknown[]) => Promise<T> },
    args: {
      placementId: string;
      clientId: string;
      month: number;
      year: number;
      calc: PayrollCalculation;
    },
  ): Promise<Record<string, unknown>> {
    const { placementId, clientId, month, year, calc } = args;

    const invoiceNo = `INV-${year}${String(month).padStart(2, '0')}-${placementId.slice(0, 6).toUpperCase()}`;
    const dueDate = new Date(year, month, 5); // 5th of the following month

    const items: { description: string; amount: number; taxable: boolean }[] = [
      { description: 'Staff Salary Component', amount: calc.grossSalary, taxable: false },
      { description: `Employer ESIC (${calc.ratesUsed.esicEmployerPct}%)`, amount: calc.esicEmployer, taxable: false },
      { description: `Employer PF (${calc.ratesUsed.pfEmployerPct}%)`, amount: calc.pfEmployer, taxable: false },
      { description: 'Management Fee', amount: calc.managementFee, taxable: true },
      { description: `GST on Management Fee (${calc.ratesUsed.gstPct}%)`, amount: calc.gstOnFee, taxable: false },
    ];

    // The invoice must be able to explain its own total. If these ever
    // disagree the invoice is not sendable, so fail the transaction rather
    // than persist a document a client would rightly query.
    const itemsTotal = round2(items.reduce((sum, i) => sum + i.amount, 0));
    if (Math.abs(itemsTotal - calc.clientTotalCharge) > 0.01) {
      throw new BadRequestException(
        `Invoice line items (${itemsTotal}) do not reconcile to the total charge ` +
        `(${calc.clientTotalCharge}) for placement ${placementId} ${month}/${year}.`,
      );
    }

    const [invoice] = await manager.query<Record<string, unknown>[]>(
      // Starts at DRAFT, not PENDING: a freshly computed invoice has been
      // approved by nobody, and the state machine's first move is DRAFT →
      // APPROVED. See F-12.
      `INSERT INTO client_invoices
         (id, placement_id, client_id, invoice_number, period_month, period_year,
          staff_salary_component, management_fee, gst_amount,
          esic_employer, pf_employer, total_amount, due_date, status)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT') RETURNING *`,
      [
        placementId, clientId, invoiceNo, month, year,
        calc.grossSalary, calc.managementFee, calc.gstOnFee,
        calc.esicEmployer, calc.pfEmployer, calc.clientTotalCharge, dueDate,
      ],
    );

    for (const item of items) {
      await manager.query(
        `INSERT INTO invoice_items (id, invoice_id, description, amount, is_taxable)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [invoice.id, item.description, item.amount, item.taxable],
      );
    }

    return invoice;
  }

  async runMonthlyPayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    // Was missing entirely — runAttendancePayroll (the newer, UI-driven path)
    // already has this check; this legacy path didn't, so calling it twice
    // for the same placement/month created two payroll_records + two
    // client_invoices rows with no error. Same guard, same shape.
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM client_invoices
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Invoice already exists for placement ${placementId} in ${month}/${year}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const placements = await manager.query<PlacementRow[]>(
        `SELECT staff_id, client_id, staff_salary, management_fee, metadata
         FROM placements WHERE id = $1`,
        [placementId],
      );
      if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
      const p = placements[0];

      const shifts = await manager.query<ShiftCountRow[]>(
        `SELECT COUNT(*) AS shift_days FROM shift_logs
         WHERE placement_id = $1
           AND EXTRACT(MONTH FROM shift_date) = $2
           AND EXTRACT(YEAR  FROM shift_date) = $3
           AND status = 'APPROVED'`,
        [placementId, month, year],
      );
      const shiftDays = parseInt(shifts[0]?.shift_days ?? '0', 10);

      const monthlySalary = parseFloat(p.staff_salary);
      const monthlyFee = parseFloat(p.management_fee);
      this.assertValidSalaryTerms(monthlySalary, monthlyFee, placementId);
      const dim = this.daysInMonth(month, year);
      const proratedGross = this.calculateProratedGross(monthlySalary, shiftDays, dim);
      const proratedFee = this.calculateProratedGross(monthlyFee, shiftDays, dim);
      // PF follows the base agreed with the client, pro-rated the same way the
      // salary is. Without a wage breakup the whole wage is the base. See F-20.
      const agreedPfBase = pfBaseFromPlacementMetadata(p.metadata);
      const proratedPfBase = agreedPfBase != null
        ? this.calculateProratedGross(agreedPfBase, shiftDays, dim)
        : undefined;
      const calc = this.calculatePayrollWithAbsoluteFee(proratedGross, proratedFee, ratesFromPlacementMetadata(p.metadata), proratedPfBase);

      const [payroll] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO payroll_records
           (id, placement_id, staff_id, period_month, period_year, shift_days,
            gross_salary, deductions, net_salary,
            esic_employer, esic_employee, pf_employer, pf_employee)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          placementId, p.staff_id, month, year, shiftDays,
          calc.grossSalary,
          JSON.stringify({ esic: calc.esicEmployee, pf: calc.pfEmployee }),
          calc.netSalary,
          calc.esicEmployer, calc.esicEmployee, calc.pfEmployer, calc.pfEmployee,
        ],
      );

      const invoice = await this.insertInvoiceWithItems(manager, {
        placementId,
        clientId: p.client_id,
        month,
        year,
        calc,
      });

      this.logger.log(`[PAYROLL] Completed placement ${placementId} ${month}/${year}`);
      return { payroll, invoice, calculation: calc };
    });
  }

  async countAttendanceForStaff(
    staffId: string,
    month: number,
    year: number,
  ): Promise<AttendanceSummary> {
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM staff_daily_attendance
       WHERE staff_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
       GROUP BY status`,
      [staffId, month, year],
    );
    return this.summarizeAttendanceCounts(rows, month, year);
  }

  async previewAttendancePayroll(placementId: string, month: number, year: number) {
    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee, metadata
       FROM placements WHERE id = $1`,
      [placementId],
    );
    if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
    const p = placements[0];

    const summary = await this.countAttendanceForStaff(p.staff_id, month, year);
    const monthlySalary = parseFloat(p.staff_salary);
    const monthlyFee = parseFloat(p.management_fee);
    this.assertValidSalaryTerms(monthlySalary, monthlyFee, placementId);
    const proratedGross = this.calculateProratedGross(
      monthlySalary,
      summary.billable_days,
      summary.days_in_month,
    );
    const proratedFee = this.calculateProratedGross(
      monthlyFee,
      summary.billable_days,
      summary.days_in_month,
    );
    // PF follows the base agreed with the client, pro-rated the same way the
    // salary is. Without a wage breakup the whole wage is the base. See F-20.
    const agreedPfBase = pfBaseFromPlacementMetadata(p.metadata);
    const proratedPfBase = agreedPfBase != null
      ? this.calculateProratedGross(agreedPfBase, summary.billable_days, summary.days_in_month)
      : undefined;
    const calc = this.calculatePayrollWithAbsoluteFee(proratedGross, proratedFee, ratesFromPlacementMetadata(p.metadata), proratedPfBase);

    return {
      placement_id: placementId,
      staff_id: p.staff_id,
      period_month: month,
      period_year: year,
      monthly_salary: monthlySalary,
      monthly_management_fee: monthlyFee,
      ...summary,
      prorated_gross: proratedGross,
      prorated_management_fee: proratedFee,
      calculation: calc,
    };
  }

  async runAttendancePayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM client_invoices
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Invoice already exists for placement ${placementId} in ${month}/${year}`,
      );
    }

    const preview = await this.previewAttendancePayroll(placementId, month, year);
    if (preview.billable_days <= 0) {
      throw new BadRequestException('No billable attendance days for this period');
    }

    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee
       FROM placements WHERE id = $1`,
      [placementId],
    );
    const p = placements[0];
    const calc = preview.calculation as PayrollCalculation;

    return this.dataSource.transaction(async (manager) => {
      const [payroll] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO payroll_records
           (id, placement_id, staff_id, period_month, period_year, shift_days,
            gross_salary, deductions, net_salary,
            esic_employer, esic_employee, pf_employer, pf_employee)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          placementId,
          p.staff_id,
          month,
          year,
          preview.billable_days,
          calc.grossSalary,
          JSON.stringify({ esic: calc.esicEmployee, pf: calc.pfEmployee }),
          calc.netSalary,
          calc.esicEmployer,
          calc.esicEmployee,
          calc.pfEmployer,
          calc.pfEmployee,
        ],
      );

      const invoice = await this.insertInvoiceWithItems(manager, {
        placementId,
        clientId: p.client_id,
        month,
        year,
        calc,
      });

      this.logger.log(`[ATTENDANCE_PAYROLL] placement ${placementId} ${month}/${year}`);
      return { payroll, invoice, preview, calculation: calc };
    });
  }

  /**
   * TEMPORARY jugaad, same pattern as disburse() below: no real Razorpay
   * credentials exist yet, so try the real order first and fall back to a
   * clearly-marked simulated order instead of throwing. This was also never
   * called from any frontend page at all — confirmed via the finance audit,
   * no invoice could ever get a payable link. Now also persists the order id
   * onto client_invoices so the settlement webhook has something to match
   * against later (it previously always stayed NULL).
   */
  async createRazorpayOrder(
    invoiceId: string,
    amount: number,
  ): Promise<Record<string, unknown>> {
    let order: Record<string, unknown> = {
      id: `sim_order_${Date.now()}`,
      status: 'simulated',
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: invoiceId,
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      order = await this.getRazorpay().orders.create({
        amount: Math.round(amount * 100),   // convert Rs to paise
        currency: 'INR',
        receipt: invoiceId,
        notes: { invoiceId },
      }) as Record<string, unknown>;
    } catch (err: any) {
      this.logger.warn(`[PAYMENT-ORDER] Razorpay API unavailable (${err.message}). Returning a simulated order.`);
    }

    await this.dataSource.query(
      `UPDATE client_invoices SET razorpay_order_id = $1 WHERE id = $2`,
      [order['id'], invoiceId],
    ).catch(() => undefined);

    return order;
  }

  // ── Internal Employee Payroll ──────────────────────────────────────────────

  async countAttendanceForEmployee(
    employeeId: string,
    month: number,
    year: number,
  ): Promise<AttendanceSummary> {
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM attendance
       WHERE employee_id = $1::uuid
         AND EXTRACT(MONTH FROM date) = $2
         AND EXTRACT(YEAR  FROM date) = $3
       GROUP BY status`,
      [employeeId, month, year],
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = parseInt(row.count, 10);
    }
    const present_days = (counts['Present'] ?? 0) + (counts['Late'] ?? 0) + ((counts['Half Day'] ?? 0) * 0.5);
    const absent_days = counts['Absent'] ?? 0;
    const leave_days = counts['Leave'] ?? 0;

    return {
      present_days,
      absent_days,
      leave_days,
      overtime_days: 0,
      billable_days: present_days,
      days_in_month: this.daysInMonth(month, year),
    };
  }

  async previewEmployeePayroll(employeeId: string, month: number, year: number) {
    const employees = await this.dataSource.query<{ salary: string }[]>(
      `SELECT salary FROM employees WHERE id = $1::uuid`,
      [employeeId],
    );
    if (!employees.length) throw new NotFoundException(`Employee ${employeeId} not found`);
    const emp = employees[0];

    const summary = await this.countAttendanceForEmployee(employeeId, month, year);
    const monthlySalary = parseFloat(emp.salary);
    // employees.salary is NOT NULL in schema.prisma, so this is a pure
    // defense-in-depth backstop (matches assertValidSalaryTerms above) rather
    // than a response to a confirmed live NULL case, unlike placements.
    if (isNaN(monthlySalary)) {
      throw new BadRequestException(`Employee ${employeeId} has no valid salary set`);
    }
    const proratedBase = this.calculateProratedGross(
      monthlySalary,
      summary.billable_days,
      summary.days_in_month,
    );

    // Overtime, bonuses, reimbursements, loan EMIs and salary advances all have
    // their own modules, and the enterprise batch has always read them — this
    // path did not, so the same employee's same month produced two different
    // numbers depending on which screen ran it. See F-11.
    const earnings = await this.employeeEarningsForPeriod(employeeId, month, year);
    const proratedGross = round2(
      proratedBase + earnings.overtimeAmount + earnings.bonusAmount + earnings.reimbursementAmount,
    );

    const esic = calculateEsic(proratedGross);

    // PF is computed on the agreed base, not automatically on gross. For an
    // office employee that base is the salary structure basic; where no
    // breakdown exists the whole wage is the base. See F-20.
    const structure = await this.dataSource.query<{ basic: string | null }[]>(
      `SELECT st.basic_salary AS basic
         FROM employee_salary_profiles esp
         JOIN salary_structures st ON st.id = esp.template_id
        WHERE esp.employee_id = $1::uuid`,
      [employeeId],
    ).catch(() => [] as { basic: string | null }[]);
    const structureBasic = structure[0]?.basic != null ? parseFloat(structure[0].basic) : null;
    const pfBaseResult = await this.tax.resolvePfBase({
      gross: proratedGross,
      agreedBase: structureBasic,
      proration: summary.days_in_month > 0 ? summary.billable_days / summary.days_in_month : 1,
    });
    const pf = calculatePfFlat(pfBaseResult.base);

    // Professional tax is a state levy, and TDS is an annual liability spread
    // across the year — neither is the flat figure this used to apply. See F-16.
    const employee = await this.dataSource.query<{ state: string | null; gender: string | null }[]>(
      `SELECT state, gender FROM employees WHERE id = $1::uuid`, [employeeId],
    ).catch(() => []);
    const pt = await this.tax.professionalTax({
      state: employee[0]?.state,
      monthlyGross: proratedGross,
      month,
      gender: employee[0]?.gender,
    });
    const tdsResult = await this.tax.tds({ employeeId, monthlyGross: proratedGross, month, year });
    const ptDeduction = pt.amount;
    const tdsDeduction = tdsResult.monthlyAmount;

    const recovery = await this.employeeRecoveryForPeriod(employeeId, month, year);

    const totalDeductions = round2(
      esic.employee + pf.employee + ptDeduction + tdsDeduction +
      recovery.loanEmiDeduction + recovery.advanceDeduction,
    );
    const netSalary = Math.max(0, round2(proratedGross - totalDeductions));

    const calculation = {
      basicProrated: proratedBase,
      overtimeAmount: earnings.overtimeAmount,
      bonusAmount: earnings.bonusAmount,
      reimbursementAmount: earnings.reimbursementAmount,
      grossSalary: proratedGross,
      esicEmployee: esic.employee,
      esicEmployer: esic.employer,
      pfEmployee: pf.employee,
      pfEmployer: pf.employer,
      ptDeduction,
      tdsDeduction,
      loanEmiDeduction: recovery.loanEmiDeduction,
      advanceDeduction: recovery.advanceDeduction,
      totalDeductions,
      netSalary,
      // Why each statutory figure is what it is, so a payslip query can be
      // answered without reading the code.
      taxExplanation: {
        professionalTax: pt.reason,
        professionalTaxState: pt.state,
        tds: tdsResult.reason,
        tdsRegime: tdsResult.regime,
        // Surfaced rather than buried: a seeded slab nobody has verified
        // should not look like a confirmed one.
        needsConfirmation: pt.needsConfirmation || tdsResult.needsConfirmation,
      },
    };

    return {
      employee_id: employeeId,
      period_month: month,
      period_year: year,
      monthly_salary: monthlySalary,
      ...summary,
      prorated_gross: proratedGross,
      calculation,
      // Balances are NOT moved here. Loan/advance recovery is applied once, when
      // an enterprise payroll batch is locked (see F-19) — this path has no
      // lock step, so it shows the deduction without performing it.
      recovery_breakdown: recovery.breakdown,
      recovery_applied: false,
    };
  }

  /** Approved overtime / bonus / reimbursement for an employee in one period. */
  private async employeeEarningsForPeriod(employeeId: string, month: number, year: number) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const [ot] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(total_amount), 0) AS total FROM overtime_records
       WHERE employee_id = $1::uuid AND status = 'APPROVED' AND date BETWEEN $2 AND $3`,
      [employeeId, start, end],
    );
    const [bonus] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM bonus_records
       WHERE employee_id = $1::uuid AND status = 'APPROVED' AND month = $2 AND year = $3`,
      [employeeId, month, year],
    );
    const [reimb] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM reimbursement_requests
       WHERE employee_id = $1::uuid AND status = 'APPROVED' AND expense_date BETWEEN $2 AND $3`,
      [employeeId, start, end],
    );

    return {
      overtimeAmount: round2(parseFloat(ot?.total ?? '0')),
      bonusAmount: round2(parseFloat(bonus?.total ?? '0')),
      reimbursementAmount: round2(parseFloat(reimb?.total ?? '0')),
    };
  }

  /**
   * What this employee owes this period, and against which loan/advance.
   * Computed only — see the note in previewEmployeePayroll about F-19.
   */
  private async employeeRecoveryForPeriod(employeeId: string, month: number, year: number) {
    const loans = await this.dataSource.query<{ id: string; monthly_emi: string; remaining_amount: string }[]>(
      `SELECT id, monthly_emi, remaining_amount FROM employee_loans
       WHERE employee_id = $1::uuid AND status = 'ACTIVE' AND auto_deduction = true`,
      [employeeId],
    );
    const advances = await this.dataSource.query<{ id: string; remaining_amount: string }[]>(
      `SELECT id, remaining_amount FROM salary_advances
       WHERE employee_id = $1::uuid AND status = 'ACTIVE'
         AND recovery_month = $2 AND recovery_year = $3`,
      [employeeId, month, year],
    );

    const breakdown: {
      loans: { loanId: string; amount: number }[];
      advances: { advanceId: string; amount: number }[];
    } = { loans: [], advances: [] };

    let loanEmiDeduction = 0;
    for (const l of loans) {
      const emi = Math.min(parseFloat(l.monthly_emi), parseFloat(l.remaining_amount));
      if (emi > 0) {
        loanEmiDeduction += emi;
        breakdown.loans.push({ loanId: l.id, amount: round2(emi) });
      }
    }

    let advanceDeduction = 0;
    for (const a of advances) {
      const amt = parseFloat(a.remaining_amount);
      if (amt > 0) {
        advanceDeduction += amt;
        breakdown.advances.push({ advanceId: a.id, amount: round2(amt) });
      }
    }

    return {
      loanEmiDeduction: round2(loanEmiDeduction),
      advanceDeduction: round2(advanceDeduction),
      breakdown,
    };
  }

  async runEmployeePayroll(employeeId: string, month: number, year: number) {
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM employee_payrolls
       WHERE employee_id = $1::uuid AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [employeeId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Payroll already exists for employee ${employeeId} in ${month}/${year}`,
      );
    }

    const preview = await this.previewEmployeePayroll(employeeId, month, year);
    if (preview.billable_days <= 0) {
      throw new BadRequestException('No billable attendance days for this period');
    }

    const calc = preview.calculation;

    return this.dataSource.transaction(async (manager) => {
      const [payroll] = await manager.query<Record<string, unknown>[]>(
        // Statutory contributions go into columns as well as the deductions
        // blob: a government filing aggregates across engines and cannot be
        // asked to parse JSON, and the employer side had no home at all
        // before this. See F-06 / F-07.
        `INSERT INTO employee_payrolls
           (id, employee_id, period_month, period_year, present_days,
            gross_salary, deductions, esic_employee, esic_employer,
            pf_employee, pf_employer, net_salary, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()) RETURNING *`,
        [
          employeeId,
          month,
          year,
          preview.billable_days,
          calc.grossSalary,
          // Every component, not just ESIC + PF — the payslip renders straight
          // from this, so anything omitted here is invisible to the employee.
          JSON.stringify({
            esic: calc.esicEmployee,
            pf: calc.pfEmployee,
            professionalTax: calc.ptDeduction,
            tds: calc.tdsDeduction,
            loanEmi: calc.loanEmiDeduction,
            advance: calc.advanceDeduction,
          }),
          calc.esicEmployee,
          calc.esicEmployer,
          calc.pfEmployee,
          calc.pfEmployer,
          calc.netSalary,
        ],
      );

      this.logger.log(`[EMPLOYEE_PAYROLL] employee ${employeeId} ${month}/${year}`);
      return { payroll, preview };
    });
  }

  async getEmployeePayrolls(): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(
      `SELECT ep.id,
              ep.employee_id AS "employeeId",
              ep.period_month AS "periodMonth",
              ep.period_year AS "periodYear",
              ep.present_days AS "presentDays",
              ep.gross_salary AS "grossSalary",
              ep.deductions,
              ep.net_salary AS "netSalary",
              ep.status,
              ep.disbursed_at AS "disbursedAt",
              ep.created_at AS "createdAt",
              e.full_name AS "employeeName",
              e.employee_id AS "employeeCode",
              e.email AS "employeeEmail",
              e.department AS "department"
       FROM employee_payrolls ep
       JOIN employees e ON e.id = ep.employee_id
       ORDER BY ep.period_year DESC, ep.period_month DESC, ep.created_at DESC`,
    );
  }
}
