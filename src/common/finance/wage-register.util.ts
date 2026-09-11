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
 * It is a record of what was paid, so it takes its figures from payroll and
 * never computes a wage of its own. An earlier version priced the components
 * itself — adding a bonus and deducting LWF from the placement's wage terms —
 * and printed a net salary ₹200 higher than the one actually paid. Payroll is
 * the authority; the register only splits what payroll paid into the agreed
 * components and states what payroll deducted.
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
  /** What the days actually worked earned — always adds up to what payroll paid. */
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
  /**
   * Terms on the placement that payroll does not apply — a bonus percentage
   * or an LWF amount configured on the wage form but never paid or deducted.
   * Printed on the register as a gap rather than quietly priced in, because
   * putting them in the columns would state a wage nobody received.
   */
  configuredNotPaid: string[];
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
 * The scale is the agreed monthly wage split into components — the RM's
 * breakup where there is one, the whole wage as basic where there is not.
 *
 * The earned row is `grossPaid` divided in the scale's proportions. For a
 * monthly placement that is the same as pro-rating each component by days
 * worked — 11,000 over 7 of 30 days earns 2,566.67 either way — but taking it
 * from the paid gross means the row adds up to exactly what payroll paid,
 * whatever proration payroll used. Any rounding paisa lands on basic.
 *
 * Deductions are what payroll recorded, not what the wage terms say should
 * apply: payroll worked them out against the ESIC ceiling and the PF wage
 * limit, and a register that recalculated them could disagree with what was
 * actually taken.
 */
export function buildWageRegister(args: {
  config: WageConfigLike | null | undefined;
  monthlyWage: number;
  daysWorked: number;
  daysInMonth: number;
  /** What payroll actually paid for the period. */
  grossPaid: number;
  /** What payroll actually deducted, keyed as the payslip reports it (esic, pf, …). */
  deductionsPaid: Record<string, number> | null | undefined;
}): WageRegister {
  const { config, monthlyWage, daysWorked, daysInMonth } = args;
  const grossPaid = round2(num(args.grossPaid));
  const paid = args.deductionsPaid ?? {};

  const basic = num(config?.basic_wage);
  const da = num(config?.da);
  const hra = num(config?.hra);
  const skill = num(config?.skilled_allowance);
  const hasBreakup = basic + da + hra + skill > 0;

  // Bonus and NFH stay at zero: payroll pays the agreed wage and nothing on
  // top of it, so a bonus printed here would be a payment that never happened.
  // When payroll starts paying either, it has to arrive as its own paid
  // figure — not be derived here from a percentage on the wage form.
  const scale: Record<EarningKey, number> = hasBreakup
    ? { basic, da, hra, skill, bonus: 0, nfh: 0 }
    // No breakup was agreed, so there is nothing to split the wage into and
    // inventing a basic/HRA ratio would put a number on the register that
    // nobody agreed to. The whole wage is basic.
    : { basic: round2(monthlyWage), da: 0, hra: 0, skill: 0, bonus: 0, nfh: 0 };

  const scaleTotal = round2(EARNING_COMPONENTS.reduce((t, { key }) => t + scale[key], 0));

  const earned = Object.fromEntries(EARNING_COMPONENTS.map(({ key }) => [key, 0])) as Record<EarningKey, number>;
  if (scaleTotal > 0) {
    for (const { key } of EARNING_COMPONENTS) {
      earned[key] = round2((grossPaid * scale[key]) / scaleTotal);
    }
    // Rounding each component can leave the row a paisa off the gross. It
    // must match to the paisa, so the difference goes to basic.
    const drift = round2(grossPaid - EARNING_COMPONENTS.reduce((t, { key }) => t + earned[key], 0));
    earned.basic = round2(earned.basic + drift);
  } else {
    earned.basic = grossPaid;
  }

  const deductions: Record<DeductionKey, number> = {
    esi: round2(num(paid.esic ?? paid.esi)),
    pf: round2(num(paid.pf)),
    ptax: round2(num(paid.ptax ?? paid.professionalTax ?? paid.professional_tax)),
    lwf: round2(num(paid.lwf)),
  };

  const configuredNotPaid: string[] = [];
  if (config?.bonus_applicable !== false && num(config?.bonus_pct) > 0) {
    configuredNotPaid.push(`bonus ${num(config?.bonus_pct)}%`);
  }
  if (config?.lwf_applicable !== false && num(config?.lwf_amount) > 0 && !deductions.lwf) {
    configuredNotPaid.push(`LWF Rs.${num(config?.lwf_amount)}`);
  }
  if (num(config?.professional_tax) > 0 && !deductions.ptax) {
    configuredNotPaid.push(`professional tax Rs.${num(config?.professional_tax)}`);
  }

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
    configuredNotPaid,
  };
}
