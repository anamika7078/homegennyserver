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
import { ConsolidatedInvoiceService } from '../finance/invoice/consolidated-invoice.service';

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
    private readonly consolidatedInvoices: ConsolidatedInvoiceService,
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

  /*
   * `insertInvoiceWithItems` used to live here: it minted one invoice per
   * placement, numbered `INV-<period>-<first 6 of placement id>`. That is the
   * bug this release removes — an invoice belongs to a client, so a client
   * with three staff was getting three unrelated invoices. Both payroll paths
   * now record payroll only and hand billing to ConsolidatedInvoiceService.
   * See ONE_STAFF_MODEL_PLAN.md §B3.
   */

  async runMonthlyPayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    // Was missing entirely — calling this twice for the same placement/month
    // used to create two payroll_records with no error. Keyed off payroll
    // rather than off the invoice, because a consolidated invoice covers a
    // whole client and carries no placement_id.
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM payroll_records
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Payroll already exists for placement ${placementId} in ${month}/${year}`,
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
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

      this.logger.log(`[PAYROLL] Completed placement ${placementId} ${month}/${year}`);
      return { payroll, clientId: p.client_id, calculation: calc };
    });

    // The invoice belongs to the client, not to this placement, so it is
    // issued (or extended) outside the payroll transaction — see §B3. A
    // failure here leaves the payroll standing and the client simply
    // un-invoiced, which month-end billing will pick up.
    const invoice = await this.billClientFor(
      result.clientId as string, month, year, placementId,
    );
    return { ...result, invoice };
  }

  /**
   * Fold this placement's freshly-run payroll into its client's invoice for the
   * period, creating that invoice if it does not exist yet.
   *
   * Returns null rather than throwing when the invoice cannot be touched — an
   * already-sent invoice, for instance. The payroll is real either way, and
   * refusing to record it because billing is closed would be the wrong trade.
   */
  private async billClientFor(
    clientId: string,
    month: number,
    year: number,
    placementId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const { invoice } = await this.consolidatedInvoices.generateOrAmend(clientId, month, year);
      return invoice as Record<string, unknown>;
    } catch (e) {
      this.logger.warn(
        `[PAYROLL] Payroll for placement ${placementId} ${month}/${year} is recorded, ` +
          `but the client invoice was not updated: ${(e as Error).message}`,
      );
      return null;
    }
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

  /**
   * The payroll half of runAttendancePayroll, without the invoice.
   *
   * An invoice belongs to a *client*, not to a placement: a client with a
   * driver, a cook and a maid gets one invoice listing three people. So the
   * monthly run computes each placement's payroll here, and
   * ConsolidatedInvoiceService then issues one invoice per client from the
   * payroll records this produced. See ONE_STAFF_MODEL_PLAN.md §B1.
   *
   * Idempotent on (placement, period): re-running skips rather than paying
   * twice.
   */
  async generateAttendancePayrollOnly(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    const already = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM payroll_records
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (already.length) {
      throw new BadRequestException(
        `Payroll already exists for placement ${placementId} in ${month}/${year}`,
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

    const [payroll] = await this.dataSource.query<Record<string, unknown>[]>(
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

    this.logger.log(`[ATTENDANCE_PAYROLL_ONLY] placement ${placementId} ${month}/${year}`);
    return { payroll, preview, calculation: calc };
  }

  async runAttendancePayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    // Keyed off payroll, not off the invoice: a consolidated invoice covers a
    // whole client and carries no placement_id, so "has this placement already
    // been run?" can only be answered by payroll_records.
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM payroll_records
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Payroll already exists for placement ${placementId} in ${month}/${year}`,
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

    const result = await this.dataSource.transaction(async (manager) => {
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

      this.logger.log(`[ATTENDANCE_PAYROLL] placement ${placementId} ${month}/${year}`);
      return { payroll, clientId: p.client_id, preview, calculation: calc };
    });

    const invoice = await this.billClientFor(
      result.clientId as string, month, year, placementId,
    );
    return { ...result, invoice };
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

  /**
   * Retired. `employee_payrolls` is no longer written to.
   *
   * There was one population of staff and three engines that could pay them —
   * `payroll_records`, `employee_payrolls` and `payroll_details` — with nothing
   * stopping the same person being paid by two of them. `payroll_records` is
   * the engine that survives, because the client invoice is built from it; a
   * second writable engine means the payslip and the invoice can disagree.
   *
   * Existing rows are still read everywhere they were — payslips, ESIC and PF
   * reports, analytics, the invoice list — so nothing historical is lost. Both
   * databases held zero rows when this was closed.
   *
   * Every employee is a pipeline candidate with a placement (§B4), so their
   * payroll runs through `runAttendancePayroll` like everyone else's. See
   * ONE_STAFF_MODEL_PLAN.md §B6.
   */
  async runEmployeePayroll(employeeId: string, month: number, year: number): Promise<never> {
    const who = await this.dataSource.query<{ employee_id: string; staff_applicant_id: string | null }[]>(
      `SELECT employee_id, staff_applicant_id FROM employees WHERE id = $1::uuid`,
      [employeeId],
    );
    const code = who[0]?.employee_id ?? employeeId;

    throw new BadRequestException(
      who[0]?.staff_applicant_id
        ? `HR payroll is retired — ${code} is paid through their placement. ` +
          `Run payroll for their staff code instead, and it will appear on their ` +
          `client's invoice for ${month}/${year}.`
        : `HR payroll is retired, and ${code} is not linked to a pipeline candidate, ` +
          `so there is no placement to pay against. Onboard them from the pipeline first.`,
    );
  }

  /**
   * Existing rows are still listed — payslips, ESIC and PF filings, analytics
   * and the invoice list all read them. Only the writer is gone.
   */
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
