/**
 * Single source of truth for the statutory calculations documented in
 * "HomeGenny Platform v1.0 — EOR Payroll Rules (Hardcoded)":
 *
 *   GST   — 18%, applied ONLY to the management fee. Never to salary,
 *           employer ESIC, employer PF, or any other component.
 *   ESIC  — Employee 0.75%, Employer 3.25% of gross salary, ONLY when
 *           gross salary <= ₹21,000/month.
 *   Net   — Gross − employee ESIC − employee PF. No other deductions.
 *
 * This is the baseline the 2026-08-10 audit verified as spec-correct
 * (originally in payroll.service.ts) — payroll.service.ts now delegates to
 * these functions instead of holding its own copy, and commercial.service.ts
 * uses calculateGstOnFee/calculateEsic/calculateNetSalary to fix the same
 * three bugs the audit found there.
 *
 * PF is deliberately NOT fully centralized here beyond calculatePfFlat().
 * The spec's PF rule is ambiguous — "12% on first ₹15,000 of salary" could
 * mean a cap applied to every salary, or "Applied when salary ≤ ₹15,000"
 * could mean a cliff above which no PF applies at all. payroll.service.ts's
 * existing behavior (the audit's confirmed baseline) implements the cap
 * reading and is preserved as calculatePfFlat() below — but this is NOT
 * force-applied to commercial.service.ts, which computes PF on a different,
 * config-driven base (basic + skilled allowance + leave, with a per-category/
 * state/zone configurable ceiling) for its own reason: it's pricing a wage
 * *category* for a quotation, not one individual's actual payroll. Whether
 * that quotation-time PF model should also be constrained to the flat
 * statutory rule is a business decision, not something to silently resolve
 * here. See PHASE_3_CORE_WORKFLOW_CORRECTNESS.md for the full writeup.
 */

export const GST_RATE_DEFAULT = 18;
export const ESIC_EMPLOYEE_RATE_DEFAULT = 0.75;
export const ESIC_EMPLOYER_RATE_DEFAULT = 3.25;
export const ESIC_WAGE_LIMIT = 21_000;
export const PF_RATE_DEFAULT = 12;
export const PF_WAGE_CEILING = 15_000;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** GST applies ONLY to the management fee — never to salary or statutory contributions. */
export function calculateGstOnFee(managementFee: number, gstPct: number = GST_RATE_DEFAULT): number {
  return round2(managementFee * (gstPct / 100));
}

export interface EsicResult {
  applicable: boolean;
  employee: number;
  employer: number;
}

/** ESIC applies only when gross salary <= the statutory wage limit (₹21,000). */
export function calculateEsic(
  grossSalary: number,
  employeeRatePct: number = ESIC_EMPLOYEE_RATE_DEFAULT,
  employerRatePct: number = ESIC_EMPLOYER_RATE_DEFAULT,
  wageLimit: number = ESIC_WAGE_LIMIT,
): EsicResult {
  const applicable = grossSalary <= wageLimit;
  return {
    applicable,
    employee: applicable ? round2(grossSalary * (employeeRatePct / 100)) : 0,
    employer: applicable ? round2(grossSalary * (employerRatePct / 100)) : 0,
  };
}

export interface PfResult {
  employee: number;
  employer: number;
}

/**
 * Confirmed baseline (payroll.service.ts): 12% on min(base, ₹15,000).
 * `employerRatePct` defaults to `employeeRatePct` (the original behavior —
 * same rate/base both sides) but callers with a placement-specific
 * `wage_config` (which has genuinely distinct employer_pf_pct/employee_pf_pct)
 * can now pass both explicitly. See the ambiguity note in the file header
 * before reusing this for a context where "base" might not mean gross salary.
 */
export function calculatePfFlat(
  base: number,
  employeeRatePct: number = PF_RATE_DEFAULT,
  employerRatePct: number = employeeRatePct,
  ceiling: number = PF_WAGE_CEILING,
): PfResult {
  const pfBase = Math.min(base, ceiling);
  return {
    employee: round2(pfBase * (employeeRatePct / 100)),
    employer: round2(pfBase * (employerRatePct / 100)),
  };
}

/** Net = Gross − employee ESIC − employee PF. No other deductions per spec. */
export function calculateNetSalary(gross: number, esicEmployee: number, pfEmployee: number): number {
  return round2(gross - esicEmployee - pfEmployee);
}

/** Client Total = Gross + employer ESIC + employer PF + Management fee + GST(on fee). */
export function calculateClientTotal(
  gross: number,
  esicEmployer: number,
  pfEmployer: number,
  managementFee: number,
  gst: number,
): number {
  return round2(gross + esicEmployer + pfEmployer + managementFee + gst);
}
