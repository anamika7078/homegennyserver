import { BadRequestException } from '@nestjs/common';
import { round2 } from './statutory-calc.util';

/**
 * Per-duty (24×7 live-in) pricing, and the per-placement ESIC/PF switches.
 *
 * A live-in duty is priced as a unit: the staff member earns `duty_rate` per
 * duty and the client is billed `duty_billing_rate` per duty, all-in, before
 * GST. This is how the business already prices it on paper:
 *
 *     Priya  23 duties × ₹517 = ₹11,891 paid   ×  ₹585 = ₹13,455 billed
 *
 * The monthly model divided a monthly salary by the days in the month, so the
 * same duty paid differently in February and October; the hourly model would
 * have priced a 24-hour duty as 24 slices of a rounded hourly rate.
 */

export type RateBasis = 'MONTHLY' | 'HOURLY' | 'PER_DUTY';

/** Null rate_basis keeps the old meaning: monthly for PERMANENT, hourly for TEMPORARY. */
export function effectiveRateBasis(placementType: string | null | undefined, rateBasis: string | null | undefined): RateBasis {
  const rb = String(rateBasis ?? '').toUpperCase();
  if (rb === 'PER_DUTY' || rb === 'MONTHLY' || rb === 'HOURLY') return rb;
  return String(placementType ?? '').toUpperCase() === 'TEMPORARY' ? 'HOURLY' : 'MONTHLY';
}

/** A half day is half a duty. Overtime days are full duties. */
export const HALF_DAY_DUTY = 0.5;

export function dutiesFrom(counts: { present: number; overtime: number; halfDay: number }): number {
  return Math.round((counts.present + counts.overtime + counts.halfDay * HALF_DAY_DUTY) * 10) / 10;
}

/** Just the parts of a payroll calculation these rules touch. */
interface StatutoryFigures {
  grossSalary: number;
  esicEmployee: number;
  esicEmployer: number;
  pfEmployee: number;
  pfEmployer: number;
  netSalary: number;
  managementFee: number;
  gstOnFee: number;
  clientTotalCharge: number;
}

/**
 * Applies a placement's own terms to a computed payroll, last:
 *
 *  - ESIC and/or PF switched off → that contribution is zero on both sides,
 *    and the staff member's net pay and the client's charge follow.
 *  - PER_DUTY → the client's pre-GST charge is exactly duties × billing rate.
 *    Employer ESIC/PF, when on, are paid out of the margin rather than added
 *    on top, so the management fee is what is left. A billing rate that does
 *    not cover the pay and the employer contributions is refused rather than
 *    billed at a loss.
 *
 * `gstOnFee` is carried through untouched; the caller recomputes GST on the
 * final base (see PayrollService.applySupplierGstPolicy).
 */
export function applyPlacementTerms<T extends StatutoryFigures>(
  calc: T,
  terms: { esic: boolean; pf: boolean; billed?: number | null; label?: string },
): T {
  const esicEmployee = terms.esic ? calc.esicEmployee : 0;
  const esicEmployer = terms.esic ? calc.esicEmployer : 0;
  const pfEmployee = terms.pf ? calc.pfEmployee : 0;
  const pfEmployer = terms.pf ? calc.pfEmployer : 0;

  let managementFee = calc.managementFee;
  if (terms.billed != null) {
    managementFee = round2(terms.billed - calc.grossSalary - esicEmployer - pfEmployer);
    if (managementFee < 0) {
      throw new BadRequestException(
        `${terms.label ?? 'This placement'}: the billing rate does not cover the staff pay` +
          `${esicEmployer || pfEmployer ? ' and the employer ESIC/PF' : ''} — ` +
          `₹${round2(terms.billed).toLocaleString('en-IN')} billed against ` +
          `₹${round2(calc.grossSalary + esicEmployer + pfEmployer).toLocaleString('en-IN')} cost. ` +
          `Raise the billing rate or switch the contribution off.`,
      );
    }
  }

  const base = round2(calc.grossSalary + esicEmployer + pfEmployer + managementFee);
  return {
    ...calc,
    esicEmployee,
    esicEmployer,
    pfEmployee,
    pfEmployer,
    managementFee,
    netSalary: round2(calc.grossSalary - esicEmployee - pfEmployee),
    clientTotalCharge: round2(base + calc.gstOnFee),
  };
}
