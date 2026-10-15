/**
 * Check the wage engine against the rate card it is supposed to reproduce.
 *
 * The Terrier cost sheet is the source of truth for what a placement costs and
 * therefore for every salary and every invoice that follows. Nobody can eyeball
 * twenty-three rows across eight columns, so this runs each column of the sheet
 * through the real computeWageBreakup and prints the difference.
 *
 * The sheet prints whole rupees, so a rounding difference under a rupee is not
 * a defect; anything above it is.
 *
 *   node scratch/_check_rate_card.js
 */
let computeWageBreakup;
try {
  ({ computeWageBreakup } = require('../dist/modules/placement/wage-calculator.util'));
} catch {
  require('ts-node/register');
  ({ computeWageBreakup } = require('../src/modules/placement/wage-calculator.util'));
}

const TOLERANCE = 1.0;

/** The rates the sheet applies to every column. */
const RATES = {
  additional_hours_pct: 50,
  employer_pf_pct: 13,
  employer_pf_max: 15000,
  employee_pf_pct: 12,
  employer_esic_pct: 3.25,
  employee_esic_pct: 0.75,
  bonus_pct: 8.33,
  leave_days: 32,
  lwf_amount: 62,
  uniform_allowance: 275,
  relieving_pct: 16.67,
  management_pct: 5.5,
  professional_tax: 0,
};

/**
 * Every column of "Simpliwork Office Spaces MW Revision (Haryana) — 01-07-2024".
 * `in` is what the sheet feeds the calculation; `want` is what it prints.
 */
const COLUMNS = [
  {
    name: 'Lady Guard · Semi-Skilled · 12hr',
    in: { basic_wage: 11552, hra: 0, skilled_allowance: 0, working_hours: 12 },
    want: {
      subtotal1: 11552, additionalHours: 5776, subtotal2: 17328,
      epfoEmployer: 1733, esicEmployer: 652, bonusMonthly: 962, leaveWages: 1777.2,
      subtotal3: 22789, relieving: 3799, subtotal4: 26588, managementFee: 1462,
      totalCTC: 28051, ratePerDay: 921, ratePerHour: 115,
      grossEarnings: 20067, epfoEmployee: 1599, esicEmployee: 151,
      totalDeductions: 1750, netSalary: 18318,
    },
  },
  {
    name: 'Security Guard · Semi-Skilled · 12hr',
    in: { basic_wage: 11552, hra: 0, skilled_allowance: 0, working_hours: 12 },
    want: {
      subtotal2: 17328, epfoEmployer: 1733, esicEmployer: 652, bonusMonthly: 962,
      leaveWages: 1777, subtotal3: 22789, relieving: 3799, subtotal4: 26588,
      managementFee: 1462, totalCTC: 28051, ratePerDay: 921, ratePerHour: 115,
      grossEarnings: 20067, epfoEmployee: 1599, esicEmployee: 151, netSalary: 18318,
    },
  },
  {
    name: 'Supervisor · Skilled · 12hr',
    in: { basic_wage: 12736, hra: 0, skilled_allowance: 0, working_hours: 12 },
    want: {
      subtotal1: 12736, additionalHours: 6368, subtotal2: 19104,
      epfoEmployer: 1910, esicEmployer: 719, bonusMonthly: 1061, leaveWages: 1959,
      subtotal3: 25090, relieving: 4183, subtotal4: 29273, managementFee: 1610,
      totalCTC: 30883, ratePerDay: 1014, ratePerHour: 127,
      grossEarnings: 22124, epfoEmployee: 1763, esicEmployee: 166, netSalary: 20195,
    },
  },
  {
    name: 'Security Officer / FOE · Highly Skilled · 12hr',
    in: { basic_wage: 14041, hra: 7000, skilled_allowance: 0, working_hours: 12 },
    want: {
      subtotal1: 14041, additionalHours: 7021, subtotal2: 28062,
      epfoEmployer: 1950, esicEmployer: 1044, bonusMonthly: 1170, leaveWages: 2878,
      subtotal3: 35440, relieving: 5908, subtotal4: 41348, managementFee: 2274,
      totalCTC: 43622, ratePerDay: 1433, ratePerHour: 179,
      grossEarnings: 32110, epfoEmployee: 1800, esicEmployee: 241, netSalary: 30069,
    },
  },
  {
    name: 'Lady / Security Guard · Unskilled · 8hr',
    in: { basic_wage: 11552, hra: 2000, skilled_allowance: 0, working_hours: 8 },
    want: {
      subtotal1: 11552, additionalHours: 0, subtotal2: 13552,
      epfoEmployer: 1682, esicEmployer: 517, bonusMonthly: 962, leaveWages: 1389.93,
      subtotal3: 18440, relieving: 3074, subtotal4: 21514, managementFee: 1183,
      totalCTC: 22697, ratePerDay: 745, ratePerHour: 93,
      grossEarnings: 15904, epfoEmployee: 1553, esicEmployee: 119, netSalary: 14232,
    },
  },
  {
    name: 'Escort Guard · Unskilled · 8hr',
    in: { basic_wage: 11552, hra: 2200, skilled_allowance: 0, working_hours: 8 },
    want: {
      subtotal2: 13752, epfoEmployer: 1685, esicEmployer: 524, bonusMonthly: 962,
      leaveWages: 1410, subtotal3: 18671, relieving: 3112, subtotal4: 21783,
      managementFee: 1198, totalCTC: 22981, ratePerDay: 755, ratePerHour: 94,
      grossEarnings: 16125, epfoEmployee: 1555, esicEmployee: 121, netSalary: 14449,
    },
  },
  {
    name: 'Supervisor · Semi-Skilled · 8hr',
    in: { basic_wage: 12736, hra: 2700, skilled_allowance: 0, working_hours: 8 },
    want: {
      subtotal2: 15436, epfoEmployer: 1861, esicEmployer: 588, bonusMonthly: 1061,
      leaveWages: 1583, subtotal3: 20866, relieving: 3478, subtotal4: 24344,
      managementFee: 1339, totalCTC: 25683, ratePerDay: 843, ratePerHour: 105,
      grossEarnings: 18080, epfoEmployee: 1718, esicEmployee: 136, netSalary: 16226,
    },
  },
  {
    name: 'Supervisor · Re-batching 8hr · skilled 3916',
    in: { basic_wage: 12736, hra: 5094, skilled_allowance: 3916, working_hours: 8 },
    want: {
      subtotal2: 21746, epfoEmployer: 1950, esicEmployer: 814, bonusMonthly: 1061,
      leaveWages: 2230, subtotal3: 28138, relieving: 4691, subtotal4: 32829,
      managementFee: 1806, totalCTC: 34634, ratePerDay: 1137, ratePerHour: 142,
      grossEarnings: 25037, epfoEmployee: 1800, esicEmployee: 188, netSalary: 23050,
    },
  },
  {
    name: 'Supervisor · Re-batching 8hr · skilled 6802',
    in: { basic_wage: 12736, hra: 5094, skilled_allowance: 6802, working_hours: 8 },
    want: {
      subtotal2: 24632, epfoEmployer: 1950, esicEmployer: 917, bonusMonthly: 1061,
      leaveWages: 2526, subtotal3: 31424, relieving: 5238, subtotal4: 36662,
      managementFee: 2016, totalCTC: 38678, ratePerDay: 1270, ratePerHour: 159,
      grossEarnings: 28219, epfoEmployee: 1800, esicEmployee: 212, netSalary: 26208,
    },
  },
];

const LABELS = {
  subtotal1: 'Sub Total 1', additionalHours: 'Additional 4hrs', subtotal2: 'Sub Total 2',
  epfoEmployer: 'PF (employer)', esicEmployer: 'ESIC (employer)', bonusMonthly: 'Bonus',
  leaveWages: 'Leaves', subtotal3: 'Sub Total (statutory)', relieving: 'Relieving',
  subtotal4: 'Sub Total (pre-fee)', managementFee: 'Management Fees', totalCTC: 'Total',
  ratePerDay: 'Rate Per Day', ratePerHour: 'Rate Per Hour',
  grossEarnings: 'Wages+Leave+Bonus', epfoEmployee: 'PF (employee)',
  esicEmployee: 'ESI (employee)', totalDeductions: 'Total Deduction', netSalary: 'Net Take Home',
};

let worst = 0;
let offending = 0;
let checked = 0;

for (const col of COLUMNS) {
  const got = computeWageBreakup({ ...RATES, ...col.in });
  const rows = [];
  for (const [key, want] of Object.entries(col.want)) {
    const mine = Number(got[key]);
    const diff = mine - want;
    checked += 1;
    if (Math.abs(diff) > worst) worst = Math.abs(diff);
    const ok = Math.abs(diff) <= TOLERANCE;
    if (!ok) offending += 1;
    rows.push({
      row: LABELS[key] || key,
      sheet: want,
      ours: Math.round(mine * 100) / 100,
      diff: Math.round(diff * 100) / 100,
      verdict: ok ? 'ok' : 'OFF',
    });
  }
  const bad = rows.filter((r) => r.verdict === 'OFF');
  console.log(`\n== ${col.name} ==`);
  if (bad.length) console.table(bad);
  else console.log(`   all ${rows.length} rows within Rs.${TOLERANCE}`);
}

const expect = (label, got, want) => {
  checked += 1;
  const ok = Math.abs(Number(got) - Number(want)) <= 0.02;
  if (!ok) offending += 1;
  console.log(`  ${ok ? 'ok ' : 'OFF'}  ${label.padEnd(52)} ${Math.round(got * 100) / 100}  (want ${Math.round(want * 100) / 100})`);
};

// ── the identity payroll and the invoice depend on ─────────────────────────
// The client's cost, decomposed the way the invoice has to put it back
// together: the wage, the employer's statutory share, the agreed extras, and
// the fee. The 21% under-billing happened because a part of this was simply
// missing downstream, so the sum is worth asserting on its own.
console.log('\n== CTC decomposes the way the invoice rebuilds it ==');
for (const col of COLUMNS) {
  const b = computeWageBreakup({ ...RATES, ...col.in });
  const rebuilt = b.grossEarnings + b.epfoEmployer + b.esicEmployer + b.lwf + b.uniform
    + b.gratuity + b.relieving + b.managementFee + b.trainingCharges;
  expect(col.name, rebuilt, b.totalCTC);
}

// ── the two rows this sheet carries but leaves at zero ─────────────────────
console.log('\n== Gratuity and training ==');
const plain = computeWageBreakup({ ...RATES, ...COLUMNS[0].in });
const withGratuity = computeWageBreakup({ ...RATES, ...COLUMNS[0].in, gratuity_applicable: true });
const withTraining = computeWageBreakup({ ...RATES, ...COLUMNS[0].in, training_pct: 1 });

expect('gratuity stays off unless switched on', plain.gratuity, 0);
expect('gratuity is 4.81% of basic + DA', withGratuity.gratuity, plain.subtotal1 * 0.0481);
// It belongs to the statutory block, so relieving and the fee are taken on it
// too — charging it must raise the CTC by more than the gratuity itself.
expect('and relieving and the fee are taken on it',
  withGratuity.totalCTC, (plain.subtotal3 + plain.subtotal1 * 0.0481) * 1.1667 * 1.055);
expect('training stays zero without a percentage', plain.trainingCharges, 0);
expect('training is 1% of the pre-fee sub total',
  withTraining.trainingCharges, withTraining.subtotal4 * 0.01);
expect('and is added alongside the fee, not inside it',
  withTraining.totalCTC, withTraining.subtotal4 + withTraining.managementFee + withTraining.subtotal4 * 0.01);

console.log(`\n${checked} figures checked · ${offending} outside Rs.${TOLERANCE} · largest gap Rs.${Math.round(worst * 100) / 100}`);
process.exitCode = offending ? 1 : 0;
