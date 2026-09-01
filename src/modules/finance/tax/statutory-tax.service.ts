import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { round2 } from '../../../common/finance/statutory-calc.util';

/**
 * Professional tax and TDS, computed from stored rules rather than guessed.
 *
 * What this replaces (F-16):
 *   - PT was `gross > 15000 ? 200 : 0`. Professional tax is levied by the
 *     **state**, and **Delhi and Haryana do not levy it at all** — which is
 *     where almost every HomeGenny employee works. Every one of them has been
 *     having ₹200 a month taken for a tax their state does not charge.
 *   - TDS was `gross > 50000 ? gross * 5% : 0`. Real TDS on salary is an
 *     annual liability spread across the remaining months of the financial
 *     year, after the standard deduction and the 87A rebate.
 *
 * Rates are data, not code, because they move every Budget. Everything the
 * migration seeds is flagged `needs_confirmation`, and `ratesConfirmed()`
 * reports whether Finance has signed them off — the UI shows that, so nobody
 * mistakes a seeded default for a verified figure.
 */

export interface PtResult {
  amount: number;
  state: string | null;
  /** Why it is what it is — shown on the payslip explanation, not just a number. */
  reason: string;
  needsConfirmation: boolean;
}

export interface TdsResult {
  monthlyAmount: number;
  annualTaxableIncome: number;
  annualTax: number;
  regime: string;
  financialYear: string;
  monthsRemaining: number;
  rebateApplied: boolean;
  needsConfirmation: boolean;
  reason: string;
}

@Injectable()
export class StatutoryTaxService {
  private readonly logger = new Logger(StatutoryTaxService.name);

  constructor(private readonly dataSource: DataSource) {}

  private async setting(key: string, fallback: string): Promise<string> {
    const rows = await this.dataSource.query<{ value: unknown }[]>(
      `SELECT value FROM system_settings WHERE key = $1`, [key],
    ).catch(() => []);
    if (!rows.length) return fallback;
    const raw = rows[0].value;
    const v = typeof raw === 'string' ? raw : String(raw ?? '');
    return v.replace(/^"|"$/g, '').trim() || fallback;
  }

  /** Whether Finance has verified the seeded slabs against the current Budget. */
  async ratesConfirmed(): Promise<boolean> {
    return (await this.setting('tax.slabs_confirmed', 'false')) === 'true';
  }

  // ── Professional tax ──────────────────────────────────────────────────────

  /**
   * @param month 1-12. Maharashtra charges more in the last month of the
   *              financial year, so the month matters.
   */
  async professionalTax(args: {
    state: string | null | undefined;
    monthlyGross: number;
    month: number;
    gender?: string | null;
  }): Promise<PtResult> {
    const state = args.state?.trim() || null;
    if (!state) {
      return {
        amount: 0, state: null, needsConfirmation: true,
        reason: 'No state on record for this employee — professional tax cannot be determined, so none was deducted.',
      };
    }

    const ruleRows = await this.dataSource.query<{ levies_pt: boolean; needs_confirmation: boolean; notes: string | null }[]>(
      `SELECT levies_pt, needs_confirmation, notes FROM professional_tax_states
       WHERE LOWER(state) = LOWER($1)`,
      [state],
    ).catch(() => []);

    if (!ruleRows.length) {
      // Unknown is not the same as "does not levy". Deduct nothing, but say so.
      return {
        amount: 0, state, needsConfirmation: true,
        reason: `No professional-tax rule on file for ${state}. Nothing deducted — add the state's rule before running payroll there.`,
      };
    }

    const rule = ruleRows[0];
    if (!rule.levies_pt) {
      return {
        amount: 0, state, needsConfirmation: rule.needs_confirmation,
        reason: rule.notes ?? `${state} does not levy professional tax.`,
      };
    }

    const gender = (args.gender ?? '').trim().toUpperCase();
    type PtSlabRow = {
      min_monthly_gross: string; max_monthly_gross: string | null;
      monthly_amount: string; february_amount: string | null;
      applies_to_gender: string | null; needs_confirmation: boolean;
    };
    const slabs: PtSlabRow[] = await this.dataSource.query<PtSlabRow[]>(
      `SELECT min_monthly_gross, max_monthly_gross, monthly_amount, february_amount,
              applies_to_gender, needs_confirmation
       FROM professional_tax_slabs
       WHERE LOWER(state) = LOWER($1)
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
         AND (applies_to_gender IS NULL OR UPPER(applies_to_gender) = $2 OR $2 = '')
       ORDER BY min_monthly_gross`,
      [state, gender],
    ).catch(() => [] as PtSlabRow[]);

    const match = slabs.find((s) => {
      const min = parseFloat(s.min_monthly_gross);
      const max = s.max_monthly_gross === null ? Infinity : parseFloat(s.max_monthly_gross);
      return args.monthlyGross > min && args.monthlyGross <= max;
    }) ?? slabs.find((s) => args.monthlyGross <= parseFloat(s.max_monthly_gross ?? 'Infinity'));

    if (!match) {
      return {
        amount: 0, state, needsConfirmation: true,
        reason: `${state} levies professional tax but no slab covers a gross of ₹${args.monthlyGross}.`,
      };
    }

    // February is the last month of the Indian financial year, when some
    // states charge a higher figure to true up the annual total.
    const isLastFyMonth = args.month === 2;
    const amount = isLastFyMonth && match.february_amount
      ? parseFloat(match.february_amount)
      : parseFloat(match.monthly_amount);

    return {
      amount: round2(amount),
      state,
      needsConfirmation: match.needs_confirmation,
      reason: amount === 0
        ? `Below the ${state} professional-tax threshold.`
        : `${state} professional tax${isLastFyMonth && match.february_amount ? ' (last month of the financial year)' : ''}.`,
    };
  }

  // ── TDS ───────────────────────────────────────────────────────────────────

  /**
   * Monthly TDS from an annual projection.
   *
   * Annualises the month's gross across the remaining financial year, applies
   * the standard deduction and slabs, checks the 87A rebate, adds cess, then
   * spreads what is still owed over the months left. A flat percentage of one
   * month's pay — the old behaviour — over-deducts from anyone whose annual
   * income lands below a slab boundary and under-deducts from everyone else.
   */
  async tds(args: {
    employeeId?: string | null;
    monthlyGross: number;
    month: number;
    year: number;
  }): Promise<TdsResult> {
    const financialYear = await this.setting('tax.financial_year', '2026-27');
    const defaultRegime = await this.setting('tax.default_regime', 'NEW');
    const standardDeduction = parseFloat(await this.setting('tax.standard_deduction', '75000'));
    const rebateLimit = parseFloat(await this.setting('tax.rebate_87a_limit', '1200000'));
    const cessPct = parseFloat(await this.setting('tax.cess_pct', '4'));
    const confirmed = await this.ratesConfirmed();

    let regime = defaultRegime;
    let declaredDeductions = 0;
    let alreadyPaid = 0;

    if (args.employeeId) {
      const prof = await this.dataSource.query<{
        regime: string; declared_deductions: string; tds_paid_this_fy: string;
      }[]>(
        `SELECT regime, declared_deductions, tds_paid_this_fy
         FROM employee_tax_profiles WHERE employee_id = $1::uuid`,
        [args.employeeId],
      ).catch(() => []);
      if (prof.length) {
        regime = prof[0].regime || defaultRegime;
        declaredDeductions = parseFloat(prof[0].declared_deductions ?? '0');
        alreadyPaid = parseFloat(prof[0].tds_paid_this_fy ?? '0');
      }
    }

    // The Indian financial year runs April–March, so April is month 1 of 12.
    const fyMonthIndex = args.month >= 4 ? args.month - 3 : args.month + 9;
    const monthsRemaining = Math.max(1, 13 - fyMonthIndex);

    const projectedAnnualGross = round2(args.monthlyGross * 12);
    // Declared deductions only reduce taxable income under the old regime.
    const deductions = standardDeduction + (regime === 'OLD' ? declaredDeductions : 0);
    const annualTaxableIncome = Math.max(0, round2(projectedAnnualGross - deductions));

    type ItSlabRow = { min_annual: string; max_annual: string | null; rate_pct: string; needs_confirmation: boolean };
    const slabs: ItSlabRow[] = await this.dataSource.query<ItSlabRow[]>(
      `SELECT min_annual, max_annual, rate_pct, needs_confirmation
       FROM income_tax_slabs
       WHERE regime = $1 AND financial_year = $2
       ORDER BY min_annual`,
      [regime, financialYear],
    ).catch(() => [] as ItSlabRow[]);

    if (!slabs.length) {
      return {
        monthlyAmount: 0, annualTaxableIncome, annualTax: 0, regime, financialYear,
        monthsRemaining, rebateApplied: false, needsConfirmation: true,
        reason: `No ${regime} regime slabs on file for FY ${financialYear}. Nothing deducted — seed the slabs before running payroll.`,
      };
    }

    let tax = 0;
    for (const s of slabs) {
      const min = parseFloat(s.min_annual);
      const max = s.max_annual === null ? Infinity : parseFloat(s.max_annual);
      if (annualTaxableIncome <= min) break;
      const slice = Math.min(annualTaxableIncome, max) - min;
      tax += slice * (parseFloat(s.rate_pct) / 100);
    }
    tax = round2(tax);

    // Section 87A: below the threshold the liability is rebated to nil.
    const rebateApplied = annualTaxableIncome <= rebateLimit;
    if (rebateApplied) tax = 0;

    const annualTax = round2(tax > 0 ? tax * (1 + cessPct / 100) : 0);
    const stillOwed = Math.max(0, round2(annualTax - alreadyPaid));
    const monthlyAmount = round2(stillOwed / monthsRemaining);

    return {
      monthlyAmount,
      annualTaxableIncome,
      annualTax,
      regime,
      financialYear,
      monthsRemaining,
      rebateApplied,
      needsConfirmation: !confirmed || slabs.some((s) => s.needs_confirmation),
      reason: rebateApplied
        ? `Projected annual income of ₹${annualTaxableIncome} is within the 87A rebate — no TDS.`
        : `₹${annualTax} projected for FY ${financialYear} (${regime} regime), spread over ${monthsRemaining} remaining month(s).`,
    };
  }

  // ── PF base (F-20) ────────────────────────────────────────────────────────

  /**
   * Three different PF bases were in use at once:
   *
   *   - `wage-calculator.util.ts` and `commercial.service.ts` quoted the client
   *     PF on `basic + skilled allowance + leave wages`, and stored the result
   *     as `wage_breakup.pfBase` on the placement.
   *   - `enterprise-payroll.service.ts` deducted PF on `min(basic, 15000)`.
   *   - `payroll.service.ts` deducted PF on `min(gross, 15000)`.
   *
   * So payroll could deduct a different figure from the one quoted to the
   * client for the same person. That is the actual defect — not "gross versus
   * basic", which is a false choice.
   *
   * There is one rule underneath: **PF is computed on the agreed PF base, and
   * where no breakdown exists the whole wage is that base.** Statutorily the
   * base is basic + DA, and for a maid or a driver on a single undifferentiated
   * wage the whole wage *is* the basic — so the EOR path's "gross" was right
   * for staff without a breakup and wrong for the five placements that have one.
   *
   * `pf.base_rule` makes the choice explicit rather than implicit:
   *   AGREED_BASE (default) — the rule above.
   *   GROSS                 — the legacy behaviour, for anyone who wants the
   *                           old numbers back while they review the impact.
   */
  async pfBaseRule(): Promise<'AGREED_BASE' | 'GROSS'> {
    const v = await this.setting('pf.base_rule', 'AGREED_BASE');
    return v === 'GROSS' ? 'GROSS' : 'AGREED_BASE';
  }

  /**
   * The base PF should be computed on for one pay run.
   *
   * @param gross     The pro-rated gross actually being paid.
   * @param agreedBase The base agreed for this person at full month, if any —
   *                   `wage_breakup.pfBase` for a placement, the salary
   *                   structure's basic for an office employee.
   * @param proration billable days ÷ days in month, so an agreed base stated
   *                  for a full month is scaled the same way the salary was.
   */
  async resolvePfBase(args: {
    gross: number;
    agreedBase?: number | null;
    proration?: number;
  }): Promise<{ base: number; source: 'AGREED' | 'GROSS'; reason: string }> {
    const rule = await this.pfBaseRule();

    if (rule === 'GROSS') {
      return {
        base: args.gross,
        source: 'GROSS',
        reason: 'pf.base_rule is set to GROSS — PF is computed on full gross for every path.',
      };
    }

    const agreed = args.agreedBase;
    if (agreed != null && Number.isFinite(agreed) && agreed > 0) {
      const ratio = args.proration == null ? 1 : args.proration;
      const scaled = round2(agreed * ratio);
      return {
        base: scaled,
        source: 'AGREED',
        reason:
          ratio === 1
            ? 'PF computed on the agreed PF base for this person.'
            : `PF computed on the agreed base, pro-rated to the days paid (${Math.round(ratio * 100)}%).`,
      };
    }

    return {
      base: args.gross,
      source: 'GROSS',
      reason: 'No separate PF base agreed — the wage is undifferentiated, so the whole wage is the base.',
    };
  }

  /**
   * What switching the rule would change, in rupees, before anyone switches it.
   *
   * Only the placements that carry a `wage_breakup.pfBase` can differ; for
   * everyone else the two rules give the same answer, which is worth showing
   * so the change does not look bigger than it is.
   */
  async pfBaseImpact() {
    const rows = await this.dataSource.query<{
      staff_code: string; full_name: string; staff_salary: string; agreed_base: string | null;
    }[]>(
      `SELECT sa.staff_code, sa.full_name, p.staff_salary,
              (p.metadata->'wage_breakup'->>'pfBase') AS agreed_base
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       WHERE p.status = 'CONFIRMED'
         AND p.staff_salary IS NOT NULL
       ORDER BY sa.staff_code`,
    ).catch(() => []);

    const ceiling = 15_000;
    const rate = 12;
    let differing = 0;
    let withAgreedBase = 0;
    let bothAboveCeiling = 0;
    let monthlyDelta = 0;

    const detail = rows.map((r) => {
      const gross = parseFloat(r.staff_salary);
      const agreed = r.agreed_base != null ? parseFloat(r.agreed_base) : null;
      if (agreed != null && agreed > 0) withAgreedBase++;

      const grossPf = round2(Math.min(gross, ceiling) * (rate / 100));
      const agreedPf = agreed != null && agreed > 0
        ? round2(Math.min(agreed, ceiling) * (rate / 100))
        : grossPf;

      // Both bases capped at the ceiling give the same PF, so the choice of
      // base only changes anything below ₹15,000.
      if (agreed != null && agreed > 0 && gross >= ceiling && agreed >= ceiling) bothAboveCeiling++;

      const delta = round2(agreedPf - grossPf);
      if (Math.abs(delta) > 0.01) { differing++; monthlyDelta += delta; }

      return {
        staff_code: r.staff_code,
        full_name: r.full_name,
        gross,
        agreed_base: agreed,
        pf_on_gross: grossPf,
        pf_on_agreed_base: agreedPf,
        // Per side. Employer matches employee, so the company's monthly
        // change is twice this.
        delta_per_side: delta,
      };
    });

    const note = differing > 0
      ? `${differing} placement(s) would deduct a different PF under the two rules. Employer PF ` +
        `matches employee PF, so the company's monthly change is double the employee-side figure.`
      : withAgreedBase === 0
        ? 'No confirmed placement carries a separately agreed PF base, so both rules give the same answer today.'
        : `${withAgreedBase} placement(s) carry an agreed PF base, but every one of them sits at or above ` +
          `the ₹${ceiling.toLocaleString('en-IN')} PF ceiling — both rules cap to the same figure, so the ` +
          `choice costs nothing today. It starts to matter the moment someone is placed below the ceiling.`;

    return {
      current_rule: await this.pfBaseRule(),
      placements_checked: rows.length,
      placements_with_agreed_base: withAgreedBase,
      placements_that_differ: differing,
      agreed_bases_above_ceiling: bothAboveCeiling,
      pf_ceiling: ceiling,
      monthly_delta_employee_side: round2(monthlyDelta),
      monthly_delta_total_both_sides: round2(monthlyDelta * 2),
      note,
      detail: detail.filter((d) => Math.abs(d.delta_per_side) > 0.01),
    };
  }

  // ── Admin surface ─────────────────────────────────────────────────────────

  async listPtRules() {
    const states = await this.dataSource.query(
      `SELECT state, levies_pt, needs_confirmation, notes FROM professional_tax_states ORDER BY state`,
    );
    const slabs = await this.dataSource.query(
      `SELECT * FROM professional_tax_slabs ORDER BY state, applies_to_gender, min_monthly_gross`,
    );
    return { states, slabs };
  }

  async listIncomeTaxSlabs(financialYear?: string) {
    const fy = financialYear ?? (await this.setting('tax.financial_year', '2026-27'));
    return {
      financial_year: fy,
      confirmed: await this.ratesConfirmed(),
      slabs: await this.dataSource.query(
        `SELECT * FROM income_tax_slabs WHERE financial_year = $1 ORDER BY regime, min_annual`,
        [fy],
      ),
    };
  }

  /** Marks the seeded rates as verified — a deliberate, auditable action. */
  async confirmRates(actorId?: string) {
    await this.dataSource.query(
      `UPDATE system_settings SET value = '"true"'::jsonb, updated_by = $1, updated_at = NOW()
       WHERE key = 'tax.slabs_confirmed'`,
      [actorId ?? null],
    );
    await this.dataSource.query(`UPDATE professional_tax_slabs SET needs_confirmation = false`);
    await this.dataSource.query(`UPDATE professional_tax_states SET needs_confirmation = false`);
    await this.dataSource.query(`UPDATE income_tax_slabs SET needs_confirmation = false`);
    this.logger.log(`[TAX] Slabs confirmed by ${actorId ?? 'unknown'}`);
    return { confirmed: true };
  }
}
