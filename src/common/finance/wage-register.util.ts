/**
 * The wage register a salary slip has to be, not a summary of one.
 *
 * Under the Contract Labour rules the same document stands in for the muster
 * roll (Form XVI), the register of wages (Form XVII) and the wage slip
 * (Form XIX), which is why the reference slips this follows carry all three
 * form numbers across the top. A register has to show two things a summary
 * does not: the **paying scale** — what the person is entitled to for a full
 * month — and the **wage earned** — what that came to for the days actually
 * worked. An inspector compares the two; a slip showing only a gross figure
 * cannot be checked against anything.
 *
 * Only the components HomeGenny staff actually attract appear here. The
 * reference format carries seventeen columns because a security agency pays
 * gun allowance and washing allowance; printing those as permanent zeroes
 * would be copying a form rather than keeping a register.
 */

/** What HomeGenny pays. Order is the order they print in. */
export const EARNING_COMPONENTS = [
  { key: 'basic', label: 'BASIC' },
  { key: 'da', label: 'DA' },
  { key: 'hra', label: 'HRA' },
  { key: 'skill', label: 'SKILL-ALL' },
  { key: 'bonus', label: 'BONUS' },
  { key: 'nfh', label: 'NFH' },
] as const;

/** What comes off it. */
export const DEDUCTION_COMPONENTS = [
  { key: 'esi', label: 'ESI' },
  { key: 'pf', label: 'PF' },
  { key: 'ptax', label: 'P.TAX' },
  { key: 'lwf', label: 'LWF' },
] as const;

export type EarningKey = (typeof EARNING_COMPONENTS)[number]['key'];
export type DeductionKey = (typeof DEDUCTION_COMPONENTS)[number]['key'];

/**
 * The wage terms agreed for a placement, as the RM's wage form stores them in
 * `placement.metadata.wage_config`.
 */
export interface WageConfigLike {
  basic_wage?: number | string;
  da?: number | string;
  hra?: number | string;
  skilled_allowance?: number | string;
  bonus_pct?: number | string;
  bonus_applicable?: boolean;
  lwf_amount?: number | string;
  lwf_applicable?: boolean;
  professional_tax?: number | string;
  nfh_applicable?: boolean;
}

export interface WageRegister {
  /** Full-month entitlement, component by component. */
  scale: Record<EarningKey, number>;
  /** What the days actually worked earned. */
  earned: Record<EarningKey, number>;
  deductions: Record<DeductionKey, number>;
  scaleTotal: number;
  earnedTotal: number;
  deductionTotal: number;
  netPayable: number;
  daysWorked: number;
  daysInMonth: number;
  /**
   * True when no wage breakup was agreed for this placement, so the whole
   * wage sits in BASIC. Worth surfacing: a register that shows an
   * undifferentiated wage is legal but tells an inspector nothing about how
   * minimum-wage components were met.
   */
  undifferentiated: boolean;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build the register for one person, one month.
 *
 * `monthlyWage` is the placement's agreed monthly figure and is what the
 * scale falls back to when no breakup was configured. The earned row is the
 * scale pro-rated by days worked, which is how the reference registers do it
 * — 18,456.00 over 5 of 31 days earns 2,977.
 *
 * Statutory deductions are passed in rather than recomputed: payroll already
 * worked them out against the ESIC ceiling and the PF wage limit, and a slip
 * that recalculated them could disagree with what was actually deducted.
 */
export function buildWageRegister(args: {
  config: WageConfigLike | null | undefined;
  monthlyWage: number;
  daysWorked: number;
  daysInMonth: number;
  esicEmployee: number;
  pfEmployee: number;
}): WageRegister {
  const { config, monthlyWage, daysWorked, daysInMonth, esicEmployee, pfEmployee } = args;

  const basic = num(config?.basic_wage);
  const da = num(config?.da);
  const hra = num(config?.hra);
  const skill = num(config?.skilled_allowance);
  const hasBreakup = basic + da + hra + skill > 0;

  // Bonus is a percentage of basic + DA where it applies at all.
  const bonusPct = config?.bonus_applicable === false ? 0 : num(config?.bonus_pct);
  const bonus = hasBreakup ? round2(((basic + da) * bonusPct) / 100) : 0;

  // NFH is a national-festival-holiday payment, earned on the day rather than
  // accrued monthly, so it has no place in the scale row.
  const nfh = 0;

  const scale: Record<EarningKey, number> = hasBreakup
    ? { basic, da, hra, skill, bonus, nfh }
    // No breakup was agreed, so there is nothing to split the wage into and
    // inventing a basic/HRA ratio would put a number on the register that
    // nobody agreed to. The whole wage is basic.
    : { basic: round2(monthlyWage), da: 0, hra: 0, skill: 0, bonus: 0, nfh: 0 };

  const ratio = daysInMonth > 0 ? daysWorked / daysInMonth : 0;
  const earned = Object.fromEntries(
    EARNING_COMPONENTS.map(({ key }) => [key, round2(scale[key] * ratio)]),
  ) as Record<EarningKey, number>;

  const deductions: Record<DeductionKey, number> = {
    esi: round2(esicEmployee),
    pf: round2(pfEmployee),
    ptax: num(config?.professional_tax),
    lwf: config?.lwf_applicable === false ? 0 : num(config?.lwf_amount),
  };

  const scaleTotal = round2(EARNING_COMPONENTS.reduce((t, { key }) => t + scale[key], 0));
  const earnedTotal = round2(EARNING_COMPONENTS.reduce((t, { key }) => t + earned[key], 0));
  const deductionTotal = round2(DEDUCTION_COMPONENTS.reduce((t, { key }) => t + deductions[key], 0));

  return {
    scale,
    earned,
    deductions,
    scaleTotal,
    earnedTotal,
    deductionTotal,
    netPayable: round2(earnedTotal - deductionTotal),
    daysWorked,
    daysInMonth,
    undifferentiated: !hasBreakup,
  };
}
