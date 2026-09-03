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

    // Payroll stops here. It computes what the staff member earned and leaves
    // the payroll row un-invoiced; the invoice is a separate, deliberate act,
    // raised by Finance from the client's unit code once they have looked at
    // who worked there. Running payroll used to issue the invoice itself,
    // which meant a document went out as a side effect of a different button.
    return result;
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

  /**
   * What this staff member earned across every client in the month, and each
   * client's share of it.
   *
   * ESIC and PF belong to the person, not to the engagement: the ₹21,000 ESIC
   * ceiling applies to what they earned altogether. Computed per placement, a
   * maid earning ₹30,000 across three houses would look like three people
   * earning ₹10,000 — every one under the ceiling — and each client would be
   * charged ESIC that is not owed.
   *
   * So the statutory figures are worked out once on the total, and each client
   * carries its share in proportion to what it paid.
   * See docs/HOURLY_MULTI_CLIENT_PLAN.md §B3.
   */
  private async staffMonthEarnings(staffId: string, month: number, year: number) {
    const rows = await this.dataSource.query<{
      id: string;
      placement_type: string;
      staff_salary: string | null;
      hourly_rate: string | null;
      present_days: string;
      hours: string;
    }[]>(
      `SELECT p.id, p.placement_type, p.staff_salary, p.hourly_rate,
              COALESCE(a.present_days, 0)::text AS present_days,
              COALESCE(a.hours, 0)::text        AS hours
         FROM placements p
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (
                    WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')
                  ) AS present_days,
                  SUM(hours_worked) FILTER (
                    WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')
                  ) AS hours
             FROM staff_daily_attendance sda
            WHERE sda.placement_id = p.id
              AND EXTRACT(MONTH FROM sda.attendance_date) = $2
              AND EXTRACT(YEAR  FROM sda.attendance_date) = $3
         ) a ON true
        WHERE p.staff_id = $1
          AND p.status IN ('CONFIRMED', 'TRIAL')`,
      [staffId, month, year],
    );

    const daysInMonth = this.daysInMonth(month, year);
    const perPlacement = rows.map((r) => {
      const gross = r.placement_type === 'TEMPORARY'
        ? round2(parseFloat(r.hours) * parseFloat(r.hourly_rate ?? '0'))
        : this.calculateProratedGross(
            parseFloat(r.staff_salary ?? '0'), parseInt(r.present_days, 10), daysInMonth,
          );
      return { placementId: r.id, gross };
    });

    const totalGross = round2(perPlacement.reduce((s, x) => s + x.gross, 0));
    return { perPlacement, totalGross };
  }

  /**
   * The days worked *at one client*, and the hours behind them.
   *
   * Payroll used to count by staff member, which was the same thing while
   * everyone had a single placement. Now that a maid works several houses, it
   * is not: counting by staff would bill every client for every day she worked
   * anywhere. See docs/HOURLY_MULTI_CLIENT_PLAN.md §B2.
   */
  async countAttendanceForPlacement(
    placementId: string,
    month: number,
    year: number,
  ): Promise<AttendanceSummary & { hours_worked: number }> {
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM staff_daily_attendance
       WHERE placement_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
       GROUP BY status`,
      [placementId, month, year],
    );

    // Only days that are actually worked carry hours. A LEAVE day with hours
    // recorded against it would otherwise be billed.
    const hours = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(hours_worked), 0)::text AS total
       FROM staff_daily_attendance
       WHERE placement_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
         AND status IN ('PRESENT', 'HALF_DAY', 'OVERTIME')`,
      [placementId, month, year],
    );

    return {
      ...this.summarizeAttendanceCounts(rows, month, year),
      hours_worked: round2(parseFloat(hours[0]?.total ?? '0')),
    };
  }

  async previewAttendancePayroll(placementId: string, month: number, year: number) {
    const placements = await this.dataSource.query<
      (PlacementRow & {
        placement_type: string;
        hourly_rate: string | null;
        hourly_fee: string | null;
        shift_hours: string | null;
      })[]
    >(
      `SELECT staff_id, client_id, staff_salary, management_fee, metadata,
              placement_type, hourly_rate, hourly_fee, shift_hours
       FROM placements WHERE id = $1`,
      [placementId],
    );
    if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
    const p = placements[0];

    // Counted at this client, not across the staff member's whole month — she
    // may be working three houses. See §B2.
    const summary = await this.countAttendanceForPlacement(placementId, month, year);
    const isHourly = p.placement_type === 'TEMPORARY';

    const monthlySalary = parseFloat(p.staff_salary ?? '0');
    const monthlyFee = parseFloat(p.management_fee ?? '0');
    const hourlyRate = p.hourly_rate != null ? parseFloat(p.hourly_rate) : 0;
    const hourlyFee = p.hourly_fee != null ? parseFloat(p.hourly_fee) : 0;

    let proratedGross: number;
    let proratedFee: number;

    if (isHourly) {
      // Hours are the whole basis. A client who booked four hours owes four
      // hours, whether that was one visit or a month of them.
      if (!(hourlyRate > 0)) {
        throw new BadRequestException(
          `Placement ${placementId} is hourly but carries no hourly_rate — nothing to bill.`,
        );
      }
      proratedGross = round2(summary.hours_worked * hourlyRate);
      proratedFee = round2(summary.hours_worked * hourlyFee);
    } else {
      this.assertValidSalaryTerms(monthlySalary, monthlyFee, placementId);
      proratedGross = this.calculateProratedGross(
        monthlySalary,
        summary.billable_days,
        summary.days_in_month,
      );
      proratedFee = this.calculateProratedGross(
        monthlyFee,
        summary.billable_days,
        summary.days_in_month,
      );
    }
    // PF follows the base agreed with the client, pro-rated the same way the
    // salary is. Without a wage breakup the whole wage is the base. See F-20.
    // An hourly placement has no agreed monthly base to pro-rate, so the hours
    // earned are the base.
    const agreedPfBase = pfBaseFromPlacementMetadata(p.metadata);
    const proratedPfBase = isHourly
      ? undefined
      : agreedPfBase != null
        ? this.calculateProratedGross(agreedPfBase, summary.billable_days, summary.days_in_month)
        : undefined;
    const rates = ratesFromPlacementMetadata(p.metadata);

    // Statutory once on the month's whole earnings, then this client's share.
    // See staffMonthEarnings() for why per-placement would be wrong.
    const monthEarnings = await this.staffMonthEarnings(p.staff_id, month, year);
    const share = monthEarnings.totalGross > 0
      ? proratedGross / monthEarnings.totalGross
      : 1;

    let calc = this.calculatePayrollWithAbsoluteFee(
      proratedGross, proratedFee, rates, proratedPfBase,
    );

    // Only worth recomputing when the staff member actually works elsewhere —
    // otherwise the share is 1 and the figures are already correct.
    if (monthEarnings.perPlacement.length > 1) {
      const whole = this.calculatePayrollWithAbsoluteFee(
        monthEarnings.totalGross, proratedFee, rates,
      );
      calc = {
        ...calc,
        esicEmployee: round2(whole.esicEmployee * share),
        esicEmployer: round2(whole.esicEmployer * share),
        pfEmployee: round2(whole.pfEmployee * share),
        pfEmployer: round2(whole.pfEmployer * share),
        netSalary: round2(
          proratedGross - whole.esicEmployee * share - whole.pfEmployee * share,
        ),
        clientTotalCharge: round2(
          proratedGross
            + whole.esicEmployer * share
            + whole.pfEmployer * share
            + calc.managementFee
            + calc.gstOnFee,
        ),
      };
    }

    calc = await this.applySupplierGstPolicy(calc);

    return {
      placement_id: placementId,
      /** This client's portion of one month-wide ESIC/PF figure. */
      statutory_share: round2(share * 10000) / 10000,
      month_total_gross: monthEarnings.totalGross,
      placements_this_month: monthEarnings.perPlacement.length,
      staff_id: p.staff_id,
      period_month: month,
      period_year: year,
      // What the figures above were derived from, so the invoice line can show
      // its working: "12 hours × ₹150" rather than a total nobody can check.
      placement_type: p.placement_type,
      shift_hours: p.shift_hours != null ? parseFloat(p.shift_hours) : null,
      hourly_rate: isHourly ? hourlyRate : null,
      hourly_fee: isHourly ? hourlyFee : null,
      monthly_salary: isHourly ? null : monthlySalary,
      monthly_management_fee: isHourly ? null : monthlyFee,
      ...summary,
      prorated_gross: proratedGross,
      prorated_management_fee: proratedFee,
      calculation: calc,
    };
  }

  /**
   * Make the preview charge what the invoice will actually charge.
   *
   * The calculation always applies 18% to the management fee, but
   * ConsolidatedInvoiceService issues a **Bill of Supply** with no GST at all
   * while `finance.supplier_gstin` is unset — an unregistered supplier cannot
   * charge it. The two disagreed: a preview promising ₹18,633.06 against an
   * invoice of ₹18,342.74, the difference being exactly the GST. Finance reads
   * the preview before deciding to bill, so it has to tell the truth.
   */
  private async applySupplierGstPolicy<T extends PayrollCalculation>(calc: T): Promise<T> {
    const rows = await this.dataSource.query<{ value: unknown }[]>(
      `SELECT value FROM system_settings WHERE key = 'finance.supplier_gstin' LIMIT 1`,
    );
    const raw = rows[0]?.value;
    const gstin = String(typeof raw === 'string' ? raw : (raw as { value?: unknown })?.value ?? raw ?? '')
      .replace(/^"|"$/g, '')
      .trim();
    if (gstin) return calc;

    return {
      ...calc,
      gstOnFee: 0,
      clientTotalCharge: round2(calc.clientTotalCharge - calc.gstOnFee),
      documentType: 'BILL_OF_SUPPLY',
      gstNote:
        'No GST charged — finance.supplier_gstin is not set, so this is issued as a Bill of Supply.',
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
    // What makes a period billable depends on how the placement is priced:
    // days for a permanent one, hours for an hourly one. A four-hour visit is
    // one day and would otherwise be judged the same as a full month.
    const nothingToBill = preview.placement_type === 'TEMPORARY'
      ? preview.hours_worked <= 0
      : preview.billable_days <= 0;
    if (nothingToBill) {
      throw new BadRequestException(
        preview.placement_type === 'TEMPORARY'
          ? 'No hours recorded at this client for the period.'
          : 'No billable attendance days for this period',
      );
    }

    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee
       FROM placements WHERE id = $1`,
      [placementId],
    );
    const p = placements[0];
    const calc = preview.calculation as PayrollCalculation;

    const [payroll] = await this.insertPayrollRecord(
      this.dataSource, placementId, p.staff_id, month, year, preview, calc,
    );

    this.logger.log(`[ATTENDANCE_PAYROLL_ONLY] placement ${placementId} ${month}/${year}`);
    return { payroll, preview, calculation: calc };
  }

  /**
   * The one place a payroll row is written.
   *
   * Both entry points used to inline their own near-identical INSERT, which is
   * how they drift: the hourly columns would have gone into one and not the
   * other, and an invoice would explain itself on one path and not the other.
   *
   * `hourly_rate` is stored rather than read back from the placement, so an
   * invoice issued today still shows the arithmetic a client can check after
   * the rate is renegotiated.
   */
  private insertPayrollRecord(
    runner: { query: <T = any>(sql: string, params?: unknown[]) => Promise<T> },
    placementId: string,
    staffId: string,
    month: number,
    year: number,
    preview: { billable_days: number; hours_worked?: number; placement_type?: string;
               hourly_rate?: number | null; hourly_fee?: number | null;
               prorated_management_fee?: number },
    calc: PayrollCalculation,
  ) {
    const isHourly = preview.placement_type === 'TEMPORARY';
    return runner.query<Record<string, unknown>[]>(
      `INSERT INTO payroll_records
         (id, placement_id, staff_id, period_month, period_year, shift_days,
          gross_salary, deductions, net_salary,
          esic_employer, esic_employee, pf_employer, pf_employee,
          placement_type, hours_worked, hourly_rate, hourly_fee, management_fee)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,$15,$16,$17) RETURNING *`,
      [
        placementId,
        staffId,
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
        preview.placement_type ?? 'PERMANENT',
        isHourly ? (preview.hours_worked ?? 0) : null,
        isHourly ? preview.hourly_rate : null,
        isHourly ? preview.hourly_fee : null,
        preview.prorated_management_fee ?? calc.managementFee,
      ],
    );
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
    // What makes a period billable depends on how the placement is priced:
    // days for a permanent one, hours for an hourly one. A four-hour visit is
    // one day and would otherwise be judged the same as a full month.
    const nothingToBill = preview.placement_type === 'TEMPORARY'
      ? preview.hours_worked <= 0
      : preview.billable_days <= 0;
    if (nothingToBill) {
      throw new BadRequestException(
        preview.placement_type === 'TEMPORARY'
          ? 'No hours recorded at this client for the period.'
          : 'No billable attendance days for this period',
      );
    }

    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee
       FROM placements WHERE id = $1`,
      [placementId],
    );
    const p = placements[0];
    const calc = preview.calculation as PayrollCalculation;

    const result = await this.dataSource.transaction(async (manager) => {
      const [payroll] = await this.insertPayrollRecord(
        manager, placementId, p.staff_id, month, year, preview, calc,
      );

      this.logger.log(`[ATTENDANCE_PAYROLL] placement ${placementId} ${month}/${year}`);
      return { payroll, clientId: p.client_id, preview, calculation: calc };
    });

    // No invoice here either — see runPayroll above. Finance raises it from
    // the unit code, and it lands as a DRAFT they can look at before it goes.
    return result;
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
