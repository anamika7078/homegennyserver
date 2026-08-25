/**
 * Backend port of homegenny/src/lib/finance/wageEngine.ts's computeWageBreakup —
 * kept formula-for-formula identical so RM's placement-time wage calculation
 * matches Finance's Commercial Calculator exactly. Single source of truth here
 * (not the frontend) since this now also has to serve the mobile app, and
 * financial numbers must be computed server-side, never trusted from a client.
 */

export interface WageConfigInput {
  basic_wage?: number;
  da?: number;
  hra?: number;
  skilled_allowance?: number;
  additional_hours_pct?: number;

  employer_pf_pct?: number;
  employer_pf_max?: number;
  employee_pf_pct?: number;
  employer_esic_pct?: number;
  employee_esic_pct?: number;
  bonus_pct?: number;
  leave_days?: number;
  lwf_amount?: number;
  uniform_allowance?: number;
  relieving_pct?: number;
  management_pct?: number;
  professional_tax?: number;

  pf_applicable?: boolean;
  esic_applicable?: boolean;
  bonus_applicable?: boolean;
  bonus_frequency?: 'monthly' | 'yearly';
  lwf_applicable?: boolean;
  uniform_applicable?: boolean;
  relieving_applicable?: boolean;
  nfh_applicable?: boolean;
  shift_pattern?: '8' | '12';

  working_hours?: number;

  gst_applicable?: boolean;
  gst_type?: 'intra_state' | 'inter_state';
  gst_pct?: number;
}

export interface WageBreakup {
  subtotal1: number;
  additionalHoursPct: number;
  additionalHours: number;
  subtotal2: number;
  bonusRaw: number;
  bonusMonthly: number;
  leaveWages: number;
  pfBase: number;
  epfoEmployer: number;
  esicEmployer: number;
  lwf: number;
  uniform: number;
  subtotal3: number;
  relieving: number;
  subtotal4: number;
  managementFee: number;
  totalCTC: number;
  ratePerDay: number;
  ratePerHour: number;
  grossEarnings: number;
  epfoEmployee: number;
  esicEmployee: number;
  totalDeductions: number;
  netSalary: number;
  gstOn: boolean;
  gstType: 'intra_state' | 'inter_state';
  gstRate: number;
  cgstPct: number;
  sgstPct: number;
  igstPct: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalGstAmount: number;
}

export function computeWageBreakup(d: WageConfigInput): WageBreakup {
  const basic = Number(d.basic_wage) || 0;
  const da = Number(d.da) || 0;
  const hra = Number(d.hra) || 0;
  const skilledAllowance = Number(d.skilled_allowance) || 0;

  const employerPfPct = Number(d.employer_pf_pct) || 0;
  const employerPfMax = Number(d.employer_pf_max) || 15000;
  const employeePfPct = Number(d.employee_pf_pct) || 0;
  const employerEsicPct = Number(d.employer_esic_pct) || 0;
  const employeeEsicPct = Number(d.employee_esic_pct) || 0;
  const bonusPct = Number(d.bonus_pct) || 0;
  const leaveDays = Number(d.leave_days) || 32;
  const lwfAmount = Number(d.lwf_amount) || 62;
  const uniformAllowance = Number(d.uniform_allowance) || 275;
  const relievingPct = Number(d.relieving_pct) || 0;
  const managementPct = Number(d.management_pct) || 0;
  const professionalTax = Number(d.professional_tax) || 0;

  const pfOn = d.pf_applicable !== false;
  const esicOn = d.esic_applicable !== false;
  const bonusOn = d.bonus_applicable !== false;
  const bonusFreq = d.bonus_frequency || 'monthly';
  const lwfOn = d.lwf_applicable !== false;
  const uniformOn = d.uniform_applicable !== false;
  const relievingOn = d.relieving_applicable !== false;

  const subtotal1 = basic + da;

  const effectiveShiftHours = Number(d.working_hours) || Number(d.shift_pattern) || 8;
  let additionalHoursPct = 0;
  let additionalHours = 0;
  if (effectiveShiftHours >= 12) {
    additionalHoursPct = Number(d.additional_hours_pct) || 50;
    additionalHours = subtotal1 * (additionalHoursPct / 100);
  }

  const subtotal2 = subtotal1 + additionalHours + hra + skilledAllowance;

  const bonusRaw = bonusOn ? subtotal1 * (bonusPct / 100) : 0;
  const bonusMonthly = bonusFreq === 'yearly' ? bonusRaw / 12 : bonusRaw;

  const workingYear = 312;
  const leaveWages = subtotal2 * (leaveDays / workingYear);

  const pfBase = basic + skilledAllowance + leaveWages;
  const employerPfCeiling = employerPfMax * (employerPfPct / 100);
  const epfoEmployer = pfOn
    ? Math.min(Math.round(pfBase * (employerPfPct / 100)), employerPfCeiling)
    : 0;

  const esicEmployer = esicOn
    ? (subtotal2 + leaveWages + bonusMonthly) * (employerEsicPct / 100)
    : 0;

  const lwf = lwfOn ? lwfAmount : 0;
  const uniform = uniformOn ? uniformAllowance : 0;

  const subtotal3 = subtotal2 + epfoEmployer + esicEmployer + bonusMonthly + leaveWages + lwf + uniform;
  const relieving = relievingOn ? subtotal3 * (relievingPct / 100) : 0;
  const subtotal4 = subtotal3 + relieving;
  const managementFee = subtotal4 * (managementPct / 100);
  const totalCTC = subtotal4 + managementFee;
  const ratePerDay = totalCTC / 30.45;
  const ratePerHour = ratePerDay / 8;

  const grossEarnings = subtotal2 + leaveWages + bonusMonthly;
  const employeePfCeiling = employerPfMax * (employeePfPct / 100);
  const epfoEmployee = pfOn
    ? Math.min(Math.round(pfBase * (employeePfPct / 100)), employeePfCeiling)
    : 0;
  const esicEmployee = esicOn ? grossEarnings * (employeeEsicPct / 100) : 0;
  const totalDeductions = epfoEmployee + esicEmployee + professionalTax;
  const netSalary = grossEarnings - totalDeductions;

  const gstOn = d.gst_applicable !== false;
  const gstType: 'intra_state' | 'inter_state' = d.gst_type === 'inter_state' ? 'inter_state' : 'intra_state';
  const gstRate = Number(d.gst_pct) || 18;

  let cgstPct = 0, sgstPct = 0, igstPct = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0, totalGstAmount = 0;
  if (gstOn) {
    if (gstType === 'intra_state') {
      cgstPct = gstRate / 2;
      sgstPct = gstRate / 2;
      cgstAmount = totalCTC * (cgstPct / 100);
      sgstAmount = totalCTC * (sgstPct / 100);
      totalGstAmount = cgstAmount + sgstAmount;
    } else {
      igstPct = gstRate;
      igstAmount = totalCTC * (igstPct / 100);
      totalGstAmount = igstAmount;
    }
  }

  return {
    subtotal1, additionalHoursPct, additionalHours, subtotal2, bonusRaw, bonusMonthly, leaveWages,
    pfBase, epfoEmployer, esicEmployer, lwf, uniform, subtotal3, relieving, subtotal4, managementFee,
    totalCTC, ratePerDay, ratePerHour, grossEarnings, epfoEmployee, esicEmployee, totalDeductions, netSalary,
    gstOn, gstType, gstRate, cgstPct, sgstPct, igstPct, cgstAmount, sgstAmount, igstAmount, totalGstAmount,
  };
}
