import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  calculateGstOnClientCharge,
  calculateEsic,
  calculatePfFlat,
  calculateNetSalary,
  round2,
  GST_RATE_DEFAULT,
  ESIC_EMPLOYEE_RATE_DEFAULT,
  ESIC_EMPLOYER_RATE_DEFAULT,
  PF_RATE_DEFAULT,
  PF_WAGE_CEILING,
} from '../../common/finance/statutory-calc.util';
import { readSupplierSettings } from '../../common/finance/supplier-settings';
import { applyPlacementTerms, dutiesFrom, effectiveRateBasis } from '../../common/finance/duty-billing.util';
import { isoDate, monthBounds, nextDay, type Period } from '../../common/finance/period.util';
import {
  activeChanges, applyRates, changeDatesWithin, rateOn, ratesAt, splitPeriod, type RateSnapshot,
} from '../../common/finance/rate-history';
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
  /** Counted so a per-duty placement can bill it as half a duty. */
  half_days: number;
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
    const half_days = counts.HALF_DAY ?? 0;
    return {
      present_days,
      absent_days,
      leave_days,
      overtime_days,
      half_days,
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
    // GST is on the whole consideration, not the fee — see
    // calculateGstOnClientCharge. `gstOnFee` keeps its name so the field the
    // apps read does not move under them; what it holds is the full tax.
    const taxableValue = round2(grossSalary + esic.employer + pf.employer + managementFee);
    const gstOnFee = calculateGstOnClientCharge(taxableValue, rates?.gst_pct);
    const clientTotalCharge = round2(taxableValue + gstOnFee);

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
    const taxableValue = round2(grossSalary + esic.employer + pf.employer + managementFee);
    const gstOnFee = calculateGstOnClientCharge(taxableValue);
    const clientTotalCharge = round2(taxableValue + gstOnFee);

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
  private async staffMonthEarnings(staffId: string, month: number, year: number, upTo?: string) {
    // Month-to-date when a period ends before the month does: the statutory
    // for an invoice raised on the 7th is worked out on what was earned by the
    // 7th, and the later invoices of the month true it up. See previewAttendancePayroll.
    const until = upTo ?? monthBounds(month, year).to;
    const rows = await this.dataSource.query<{
      id: string;
      placement_type: string;
      rate_basis: string | null;
      staff_salary: string | null;
      hourly_rate: string | null;
      duty_rate: string | null;
      present_days: string;
      full_days: string;
      half_days: string;
      hours: string;
    }[]>(
      `SELECT p.id, p.placement_type, p.rate_basis, p.staff_salary, p.hourly_rate, p.duty_rate,
              COALESCE(a.present_days, 0)::text AS present_days,
              COALESCE(a.full_days, 0)::text    AS full_days,
              COALESCE(a.half_days, 0)::text    AS half_days,
              COALESCE(a.hours, 0)::text        AS hours
         FROM placements p
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (
                    WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')
                  ) AS present_days,
                  COUNT(*) FILTER (WHERE status IN ('PRESENT','OVERTIME')) AS full_days,
                  COUNT(*) FILTER (WHERE status = 'HALF_DAY')              AS half_days,
                  SUM(hours_worked) FILTER (
                    WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')
                  ) AS hours
             FROM staff_daily_attendance sda
            WHERE sda.placement_id = p.id
              AND EXTRACT(MONTH FROM sda.attendance_date) = $2
              AND EXTRACT(YEAR  FROM sda.attendance_date) = $3
              AND sda.attendance_date <= $4::date
         ) a ON true
        WHERE p.staff_id = $1
          AND p.status IN ('CONFIRMED', 'TRIAL')`,
      [staffId, month, year, until],
    );

    const daysInMonth = this.daysInMonth(month, year);
    const grossOf = (
      rates: { rate_basis: string | null; staff_salary: string | number | null; hourly_rate: string | number | null; duty_rate: string | number | null },
      placementType: string,
      c: { present_days: string; full_days: string; half_days: string; hours: string },
    ) => {
      const basis = effectiveRateBasis(placementType, rates.rate_basis);
      return basis === 'PER_DUTY'
        ? round2(dutiesFrom({
            present: parseInt(c.full_days, 10), overtime: 0, halfDay: parseInt(c.half_days, 10),
          }) * parseFloat(String(rates.duty_rate ?? '0')))
        : basis === 'HOURLY'
          ? round2(parseFloat(c.hours) * parseFloat(String(rates.hourly_rate ?? '0')))
          : this.calculateProratedGross(
              parseFloat(String(rates.staff_salary ?? '0')), parseInt(c.present_days, 10), daysInMonth,
            );
    };
    const perPlacement = await Promise.all(rows.map(async (r) => {
      // A rate that changed during the month: each stretch at its own rate.
      const changes = await activeChanges(this.dataSource, r.id);
      const cuts = changes.map((c) => c.effective_from);
      const stretch = { from: monthBounds(month, year).from, to: until };
      const parts = changes.length ? splitPeriod(stretch, cuts) : [];
      if (parts.length <= 1 && !changes.length) {
        return { placementId: r.id, gross: grossOf(r, r.placement_type, r) };
      }
      let gross = 0;
      for (const part of parts.length ? parts : [stretch]) {
        const rates = rateOn(changes, part.from) as RateSnapshot;
        const [c] = await this.dataSource.query<{ present_days: string; full_days: string; half_days: string; hours: string }[]>(
          `SELECT COUNT(*) FILTER (WHERE status IN ('PRESENT','HALF_DAY','OVERTIME'))::text AS present_days,
                  COUNT(*) FILTER (WHERE status IN ('PRESENT','OVERTIME'))::text            AS full_days,
                  COUNT(*) FILTER (WHERE status = 'HALF_DAY')::text                         AS half_days,
                  COALESCE(SUM(hours_worked) FILTER (WHERE status IN ('PRESENT','HALF_DAY','OVERTIME')), 0)::text AS hours
             FROM staff_daily_attendance
            WHERE placement_id = $1 AND attendance_date BETWEEN $2::date AND $3::date`,
          [r.id, part.from, part.to],
        );
        gross += grossOf(rates, r.placement_type, c);
      }
      return { placementId: r.id, gross: round2(gross) };
    }));

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
    period?: Period,
  ): Promise<AttendanceSummary & { hours_worked: number }> {
    // A period inside the month (an invoice raised mid-month) counts only its
    // own days; with none given it is the whole month, as before.
    const range = period ?? monthBounds(month, year);
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM staff_daily_attendance
       WHERE placement_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
         AND attendance_date BETWEEN $4::date AND $5::date
       GROUP BY status`,
      [placementId, month, year, range.from, range.to],
    );

    // Only days that are actually worked carry hours. A LEAVE day with hours
    // recorded against it would otherwise be billed.
    const hours = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(hours_worked), 0)::text AS total
       FROM staff_daily_attendance
       WHERE placement_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
         AND attendance_date BETWEEN $4::date AND $5::date
         AND status IN ('PRESENT', 'HALF_DAY', 'OVERTIME')`,
      [placementId, month, year, range.from, range.to],
    );

    return {
      ...this.summarizeAttendanceCounts(rows, month, year),
      hours_worked: round2(parseFloat(hours[0]?.total ?? '0')),
    };
  }

  /**
   * The first period still unpaid for a placement this month, ending on
   * `till` (or the month's last day).
   *
   * Payroll rows never overlap for a placement, so the next one starts the day
   * after the last one ends. Returns null when the month is already covered
   * through `till`.
   */
  async nextPayrollPeriod(placementId: string, month: number, year: number, till?: string): Promise<Period | null> {
    const bounds = monthBounds(month, year);
    const to = till ?? bounds.to;
    const last = await this.dataSource.query<{ period_to: unknown }[]>(
      `SELECT MAX(period_to) AS period_to FROM payroll_records
        WHERE placement_id = $1 AND period_month = $2 AND period_year = $3`,
      [placementId, month, year],
    );
    const lastTo = isoDate(last[0]?.period_to);
    const from = lastTo ? nextDay(lastTo) : bounds.from;
    return from > to ? null : { from, to };
  }

  async previewAttendancePayroll(placementId: string, month: number, year: number, period?: Period) {
    const range = period ?? monthBounds(month, year);
    const placements = await this.dataSource.query<
      (PlacementRow & {
        placement_type: string;
        hourly_rate: string | null;
        hourly_fee: string | null;
        shift_hours: string | null;
        rate_basis: string | null;
        duty_rate: string | null;
        duty_billing_rate: string | null;
        esic_applicable: boolean | null;
        pf_applicable: boolean | null;
      })[]
    >(
      `SELECT staff_id, client_id, staff_salary, management_fee, metadata,
              placement_type, hourly_rate, hourly_fee, shift_hours,
              rate_basis, duty_rate, duty_billing_rate, esic_applicable, pf_applicable
       FROM placements WHERE id = $1`,
      [placementId],
    );
    if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
    // The rate in force on the period's first day — runPayrollForPeriod cuts a
    // period at every rate change, so one rate covers the whole of it.
    const inForce = await ratesAt(this.dataSource, placementId, range.from);
    const p = inForce ? applyRates(placements[0], inForce) : placements[0];

    // Counted at this client, not across the staff member's whole month — she
    // may be working three houses. See §B2.
    const summary = await this.countAttendanceForPlacement(placementId, month, year, range);
    const basis = effectiveRateBasis(p.placement_type, p.rate_basis);
    const isHourly = basis === 'HOURLY';
    const isPerDuty = basis === 'PER_DUTY';
    const dutyRate = p.duty_rate != null ? parseFloat(p.duty_rate) : 0;
    const dutyBillingRate = p.duty_billing_rate != null ? parseFloat(p.duty_billing_rate) : 0;
    // Present and overtime days are a full duty each, a half day is half of one.
    const duties = isPerDuty
      ? dutiesFrom({ present: summary.present_days, overtime: summary.overtime_days, halfDay: summary.half_days })
      : 0;
    // What the client pays for those duties, before GST — fixed by the rate,
    // whatever the statutory comes to. Null for the other bases.
    const dutyBilled = isPerDuty ? round2(duties * dutyBillingRate) : null;

    const monthlySalary = parseFloat(p.staff_salary ?? '0');
    const monthlyFee = parseFloat(p.management_fee ?? '0');
    const hourlyRate = p.hourly_rate != null ? parseFloat(p.hourly_rate) : 0;
    const hourlyFee = p.hourly_fee != null ? parseFloat(p.hourly_fee) : 0;

    let proratedGross: number;
    let proratedFee: number;

    if (isPerDuty) {
      // 24×7 live-in: a fixed rate per duty, never divided by the days in the
      // month — a duty in February pays what a duty in October pays.
      if (!(dutyRate > 0) || !(dutyBillingRate > 0)) {
        throw new BadRequestException(
          `Placement ${placementId} is billed per duty but has no duty rate or billing rate set.`,
        );
      }
      proratedGross = round2(duties * dutyRate);
      // Provisional: the fee is whatever the billing rate leaves after pay and
      // employer contributions, settled in applyPlacementTerms below.
      proratedFee = round2((dutyBilled ?? 0) - proratedGross);
    } else if (isHourly) {
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
    const proratedPfBase = isHourly || isPerDuty
      ? undefined
      : agreedPfBase != null
        ? this.calculateProratedGross(agreedPfBase, summary.billable_days, summary.days_in_month)
        : undefined;
    const rates = ratesFromPlacementMetadata(p.metadata);

    // Statutory once on the month's earnings, then this client's share — and,
    // when the month is billed in parts, month-to-date: worked out on what was
    // earned up to the end of this period, less what earlier periods of the
    // month already carried. The ESIC ceiling and the PF cap are monthly, so
    // computing each part on its own would apply them to fractions of a month.
    // The last period of the month therefore always lands on the monthly figure.
    // See staffMonthEarnings() for why per-placement would be wrong.
    const monthEarnings = await this.staffMonthEarnings(p.staff_id, month, year, range.to);
    const [prior] = await this.dataSource.query<{
      n: string; gross: string; esic_e: string; esic_r: string; pf_e: string; pf_r: string;
    }[]>(
      `SELECT COUNT(*)::text AS n,
              COALESCE(SUM(gross_salary), 0)::text  AS gross,
              COALESCE(SUM(esic_employee), 0)::text AS esic_e,
              COALESCE(SUM(esic_employer), 0)::text AS esic_r,
              COALESCE(SUM(pf_employee), 0)::text   AS pf_e,
              COALESCE(SUM(pf_employer), 0)::text   AS pf_r
         FROM payroll_records
        WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
          AND period_to < $4::date`,
      [placementId, month, year, range.from],
    );
    const hasPrior = Number(prior?.n ?? 0) > 0;
    const thisMonthToDate = monthEarnings.perPlacement.find((x) => x.placementId === placementId)?.gross
      ?? round2(Number(prior?.gross ?? 0) + proratedGross);
    const share = monthEarnings.totalGross > 0
      ? thisMonthToDate / monthEarnings.totalGross
      : 1;

    let calc = this.calculatePayrollWithAbsoluteFee(
      proratedGross, proratedFee, rates, proratedPfBase,
    );

    // Only worth recomputing when the staff member works elsewhere or the month
    // is being billed in parts — otherwise the figures above are already right.
    if (monthEarnings.perPlacement.length > 1 || hasPrior) {
      // The agreed PF base, pro-rated to the days worked so far this month.
      let pfBaseToDate: number | undefined;
      if (agreedPfBase != null && !isHourly && !isPerDuty && monthEarnings.perPlacement.length <= 1) {
        const toDate = await this.countAttendanceForPlacement(
          placementId, month, year, { from: monthBounds(month, year).from, to: range.to },
        );
        pfBaseToDate = this.calculateProratedGross(agreedPfBase, toDate.billable_days, toDate.days_in_month);
      }
      const whole = this.calculatePayrollWithAbsoluteFee(
        monthEarnings.totalGross, proratedFee, rates, pfBaseToDate,
      );
      const part = (wholeAmount: number, already: string | undefined) =>
        round2(wholeAmount * share - Number(already ?? 0));
      const esicEmployee = part(whole.esicEmployee, prior?.esic_e);
      const esicEmployer = part(whole.esicEmployer, prior?.esic_r);
      const pfEmployee = part(whole.pfEmployee, prior?.pf_e);
      const pfEmployer = part(whole.pfEmployer, prior?.pf_r);
      calc = {
        ...calc,
        esicEmployee, esicEmployer, pfEmployee, pfEmployer,
        netSalary: round2(proratedGross - esicEmployee - pfEmployee),
        clientTotalCharge: round2(
          proratedGross + esicEmployer + pfEmployer + calc.managementFee + calc.gstOnFee,
        ),
      };
    }

    // The placement's own terms go last: ESIC/PF switched off where they do not
    // apply, and a per-duty client charge held at exactly duties × billing rate.
    calc = applyPlacementTerms(calc, {
      esic: p.esic_applicable !== false,
      pf: p.pf_applicable !== false,
      billed: dutyBilled,
      label: `Placement ${placementId}`,
    });

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
      period_from: range.from,
      period_to: range.to,
      // What the figures above were derived from, so the invoice line can show
      // its working: "12 hours × ₹150" rather than a total nobody can check.
      placement_type: p.placement_type,
      rate_basis: basis,
      shift_hours: p.shift_hours != null ? parseFloat(p.shift_hours) : null,
      hourly_rate: isHourly ? hourlyRate : null,
      hourly_fee: isHourly ? hourlyFee : null,
      monthly_salary: isHourly || isPerDuty ? null : monthlySalary,
      monthly_management_fee: isHourly || isPerDuty ? null : monthlyFee,
      duties: isPerDuty ? duties : null,
      duty_rate: isPerDuty ? dutyRate : null,
      duty_billing_rate: isPerDuty ? dutyBillingRate : null,
      esic_applicable: p.esic_applicable !== false,
      pf_applicable: p.pf_applicable !== false,
      ...summary,
      prorated_gross: proratedGross,
      // The fee actually billed. For per-duty it is only known once the
      // statutory is settled, so it is read back from the final calculation.
      prorated_management_fee: isPerDuty ? calc.managementFee : proratedFee,
      calculation: calc,
    };
  }

  /**
   * Make the preview charge what the invoice will actually charge.
   *
   * ConsolidatedInvoiceService issues a **Bill of Supply** with no GST while
   * HomeGenny has no valid GSTIN on file, and otherwise charges the one rate
   * set under Finance → Company & GST. The preview used to differ on all
   * three counts: it treated any non-empty GSTIN as registered (the invoice
   * checks the format), it used the placement's wage_config rate (the invoice
   * did not), and for a staff member at several clients it kept GST computed
   * before ESIC/PF were re-shared, so its tax sat on a stale base.
   *
   * GST is therefore recomputed here, last, from the final base and the
   * invoice's own settings. Finance reads the preview before deciding to bill,
   * so it has to tell the truth.
   */
  private async applySupplierGstPolicy<T extends PayrollCalculation>(calc: T): Promise<T> {
    const supplier = await readSupplierSettings(this.dataSource);
    const base = round2(calc.clientTotalCharge - calc.gstOnFee);

    if (!supplier.isRegistered) {
      return {
        ...calc,
        gstOnFee: 0,
        clientTotalCharge: base,
        ratesUsed: { ...calc.ratesUsed, gstPct: 0 },
        documentType: 'BILL_OF_SUPPLY',
        gstNote:
          'No GST charged — HomeGenny has no valid GSTIN under Finance → Company & GST, ' +
          'so this is issued as a Bill of Supply.',
      };
    }

    const gst = calculateGstOnClientCharge(base, supplier.gstRatePct);
    return {
      ...calc,
      gstOnFee: gst,
      clientTotalCharge: round2(base + gst),
      ratesUsed: { ...calc.ratesUsed, gstPct: supplier.gstRatePct },
      documentType: 'TAX_INVOICE',
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
    till?: string,
  ): Promise<Record<string, unknown>> {
    const { payroll, preview, calculation } = await this.runPayrollForPeriod(placementId, month, year, till);
    this.logger.log(`[ATTENDANCE_PAYROLL_ONLY] placement ${placementId} ${preview.period_from}…${preview.period_to}`);
    return { payroll, preview, calculation };
  }

  /**
   * Pays the next unpaid stretch of the month for one placement — from the day
   * after its last payroll row (or the 1st) up to `till` (or the month end).
   *
   * A month used to be one row, run once. Now a client can be invoiced on the
   * 7th for the 1st–7th and later for the rest, so a placement can have
   * several rows in a month, one after another. They never overlap: that is
   * also enforced in the database (trg_payroll_records_no_overlap).
   *
   * The refusal message for a month already covered is unchanged, because the
   * month-end cron and the batch screens read it as "nothing left to do".
   */
  async runPayrollForPeriod(
    placementId: string,
    month: number,
    year: number,
    till?: string,
    runner?: { query: <T = any>(sql: string, params?: unknown[]) => Promise<T> },
  ) {
    const period = await this.nextPayrollPeriod(placementId, month, year, till);
    if (!period) {
      throw new BadRequestException(
        till
          ? `Payroll already exists for placement ${placementId} up to ${till}`
          : `Payroll already exists for placement ${placementId} in ${month}/${year}`,
      );
    }

    // A rate that changes inside the period: one row per stretch, each at its
    // own rate. Each part is committed before the next is worked out, so the
    // month-to-date ESIC/PF of the later part sees the earlier one — which is
    // why a caller's transaction is not used when the period is cut.
    const cuts = await changeDatesWithin(this.dataSource, placementId, period.from, period.to);
    if (cuts.length) {
      const parts = splitPeriod(period, cuts);
      let last: Awaited<ReturnType<PayrollService['runOnePeriod']>> | null = null;
      let lastError: unknown = null;
      for (const part of parts) {
        try {
          last = await this.runOnePeriod(placementId, month, year, part);
        } catch (e) {
          // A stretch with nothing worked in it is not a failure of the whole.
          if (!/^No (duties|hours|billable)/.test((e as Error).message)) throw e;
          lastError = e;
        }
      }
      if (!last) throw lastError;
      return last;
    }

    return this.runOnePeriod(placementId, month, year, period, runner);
  }

  /** Writes the payroll row for one period priced at one rate. */
  private async runOnePeriod(
    placementId: string,
    month: number,
    year: number,
    period: { from: string; to: string },
    runner?: { query: <T = any>(sql: string, params?: unknown[]) => Promise<T> },
  ) {
    const preview = await this.previewAttendancePayroll(placementId, month, year, period);
    // What makes a period billable depends on how the placement is priced:
    // duties, hours, or days. A four-hour visit is one day and would otherwise
    // be judged the same as a full month.
    const nothingToBill = preview.rate_basis === 'PER_DUTY'
      ? !(Number(preview.duties) > 0)
      : preview.rate_basis === 'HOURLY'
        ? preview.hours_worked <= 0
        : preview.billable_days <= 0;
    if (nothingToBill) {
      throw new BadRequestException(
        preview.rate_basis === 'PER_DUTY'
          ? 'No duties recorded at this client for the period.'
          : preview.rate_basis === 'HOURLY'
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

    const [inserted] = await this.insertPayrollRecord(
      runner ?? this.dataSource, placementId, p.staff_id, month, year, preview, calc,
    );
    const payroll = await this.applyPendingArrears(runner ?? this.dataSource, inserted);
    return { payroll, clientId: p.client_id, preview, calculation: calc };
  }

  /**
   * Arrears owed from the correction of an earlier, sent invoice (the staff
   * member was paid too little) ride on the next payroll row written for them,
   * at any client: added to the net, named on the slip. The client's invoice
   * is not touched — billing was settled by the correction itself.
   */
  private async applyPendingArrears(
    runner: { query: <T = any>(sql: string, params?: unknown[]) => Promise<T> },
    row: Record<string, unknown>,
  ) {
    const pending = await runner.query<{ id: string; amount: string; reason: string }[]>(
      `SELECT id, amount, reason FROM pay_adjustments
        WHERE staff_id = $1 AND kind = 'ARREARS' AND status = 'PENDING'
        ORDER BY created_at`,
      [row.staff_id],
    ).catch(() => [] as { id: string; amount: string; reason: string }[]);
    if (!pending.length) return row;
    const total = round2(pending.reduce((s, a) => s + Number(a.amount), 0));
    const note = pending.map((a) => `₹${Number(a.amount).toLocaleString('en-IN')} — ${a.reason}`).join('; ');
    const res = await runner.query(
      `UPDATE payroll_records
          SET arrears = $2, arrears_note = $3, net_salary = net_salary + $2
        WHERE id = $1 RETURNING *`,
      [row.id, total, note],
    );
    await runner.query(
      `UPDATE pay_adjustments SET status = 'APPLIED', applied_payroll_id = $2, applied_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [pending.map((a) => a.id), row.id],
    );
    this.logger.log(`[ARREARS] ₹${total} added to payroll ${String(row.id)} for staff ${String(row.staff_id)}`);
    const rows = (Array.isArray((res as unknown[])[0]) ? (res as unknown[][])[0] : res) as Record<string, unknown>[];
    return rows[0] ?? row;
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
               prorated_management_fee?: number;
               rate_basis?: string; duties?: number | null;
               duty_rate?: number | null; duty_billing_rate?: number | null;
               period_from?: string; period_to?: string },
    calc: PayrollCalculation,
  ) {
    const isHourly = preview.rate_basis
      ? preview.rate_basis === 'HOURLY'
      : preview.placement_type === 'TEMPORARY';
    const isPerDuty = preview.rate_basis === 'PER_DUTY';
    return runner.query<Record<string, unknown>[]>(
      `INSERT INTO payroll_records
         (id, placement_id, staff_id, period_month, period_year, shift_days,
          gross_salary, deductions, net_salary,
          esic_employer, esic_employee, pf_employer, pf_employee,
          placement_type, hours_worked, hourly_rate, hourly_fee, management_fee,
          rate_basis, duties, duty_rate, duty_billing_rate, period_from, period_to)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21, $22::date, $23::date) RETURNING *`,
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
        preview.rate_basis ?? null,
        isPerDuty ? preview.duties : null,
        isPerDuty ? preview.duty_rate : null,
        isPerDuty ? preview.duty_billing_rate : null,
        // Null falls back to the whole month (trg_payroll_records_fill_period).
        preview.period_from ?? null,
        preview.period_to ?? null,
      ],
    );
  }

  async runAttendancePayroll(
    placementId: string,
    month: number,
    year: number,
    till?: string,
  ): Promise<Record<string, unknown>> {
    // Keyed off payroll, not off the invoice: a consolidated invoice covers a
    // whole client and carries no placement_id, so "has this placement already
    // been run?" can only be answered by payroll_records.
    const result = await this.dataSource.transaction((manager) =>
      this.runPayrollForPeriod(placementId, month, year, till, manager));
    this.logger.log(
      `[ATTENDANCE_PAYROLL] placement ${placementId} ${result.preview.period_from}…${result.preview.period_to}`,
    );
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
      // Already folded into present_days at half weight above.
      half_days: 0,
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
