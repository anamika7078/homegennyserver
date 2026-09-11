/**
 * What the client is shown on the invoice — one line per kind of staff, and
 * nothing about how the charge is made up internally.
 *
 * A client contracts for a person to do a job at an agreed rate. Salary,
 * employer ESIC, employer PF and HomeGenny's own fee are how that rate is
 * built and are HomeGenny's business, not the client's — itemising them
 * invites an argument about the margin on every invoice, and no agency in this
 * trade bills that way. The reference invoices this format follows show
 * strength, duties, the all-in monthly rate, and the amount. That is all.
 *
 * The full breakdown is still stored on `invoice_items` and still reconciles
 * to the total — Finance, payroll and the statutory filings all read it. This
 * only changes what leaves the building.
 */

/** Designation as the client knows it, from the series the pipeline stores. */
const DESIGNATION_BY_SERIES: Record<string, string> = {
  MAID: 'Maid',
  UNSKILLED_CARE: 'Care Helper',
  SKILLED_CARE: 'Caretaker',
  DRIVER: 'Driver',
  // Short codes, which some callers still use. See the series dual-representation
  // note in the pipeline FSM.
  UC: 'Care Helper',
  SC: 'Caretaker',
  DR: 'Driver',
};

export function designationFor(series: string | null | undefined): string {
  const key = String(series ?? '').trim().toUpperCase();
  return DESIGNATION_BY_SERIES[key] ?? 'Staff';
}

/** One staff member's contribution to the invoice, as stored. */
export interface BilledStaff {
  staff_name: string;
  series: string | null;
  placement_type: string | null;
  /** Days present — "duties", in the language of the trade. */
  shift_days: number;
  /** Hours worked, for an hourly placement. */
  hours_worked: number | null;
  hourly_rate: number | null;
  /** Contracted shift length, shown on the line. */
  shift_hours: number | null;
  /** Everything this person contributes to the taxable value, added up. */
  amount: number;
}

export interface ServiceLine {
  /** How many people this line covers. */
  strength: number;
  description: string;
  amount: number;
}

function money(n: number): string {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(n);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Group what was billed into the lines the client sees.
 *
 * Monthly placements are grouped by designation and shift length, because
 * that is the unit a client thinks in — "two maids on 8-hour shifts" — and it
 * matches how the strength column is read.
 *
 * The rate shown is derived from the amount actually charged rather than from
 * the placement's stored monthly wage, and deliberately so: employer ESIC
 * stops applying above the statutory wage ceiling, so the all-in cost of a
 * part-month is not simply the full-month cost scaled down. Deriving it
 * backwards keeps the working in brackets reproducing the amount beside it,
 * which is the one thing a client will check.
 */
export function buildServiceLines(staff: BilledStaff[], daysInPeriod: number): ServiceLine[] {
  const monthly = staff.filter((s) => s.placement_type !== 'TEMPORARY');
  const hourly = staff.filter((s) => s.placement_type === 'TEMPORARY');
  const lines: ServiceLine[] = [];

  const groups = new Map<string, BilledStaff[]>();
  for (const s of monthly) {
    const key = `${designationFor(s.series)}|${s.shift_hours ?? 8}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  for (const [key, members] of groups) {
    const [designation, hoursRaw] = key.split('|');
    const hours = Number(hoursRaw) || 8;
    const duties = members.reduce((t, m) => t + (Number(m.shift_days) || 0), 0);
    const amount = round2(members.reduce((t, m) => t + (Number(m.amount) || 0), 0));
    // No duties means nobody worked, so there is no rate to state and no
    // bracket working that would make sense. Show the amount on its own.
    if (!duties) {
      lines.push({ strength: members.length, description: designation, amount });
      continue;
    }
    const rate = round2((amount * daysInPeriod) / duties);
    lines.push({
      strength: members.length,
      description:
        `${designation} — ${duties.toFixed(2)} duties at Rs.${money(rate)}/-p.m for ${hours}hrs ` +
        `[${money(rate)} × ${duties.toFixed(2)} / ${daysInPeriod}]`,
      amount,
    });
  }

  // An hourly placement is billed per hour, so it states its own working and
  // never joins a monthly group — the two cannot share a rate.
  for (const s of hourly) {
    const hoursWorked = Number(s.hours_worked) || 0;
    const amount = round2(Number(s.amount) || 0);
    const rate = hoursWorked ? round2(amount / hoursWorked) : 0;
    lines.push({
      strength: 1,
      description: hoursWorked
        ? `${designationFor(s.series)} — ${hoursWorked.toFixed(2)} hours at Rs.${money(rate)}/-per hour ` +
          `[${money(rate)} × ${hoursWorked.toFixed(2)}]`
        : `${designationFor(s.series)} — hourly`,
      amount,
    });
  }

  return lines;
}

/**
 * The first and last day the invoice covers.
 *
 * Billing runs on calendar months today, which is also what the pro-rating
 * divides by, so the range is the whole month. When the 21st-to-20th cycle
 * lands this is the one place that has to change.
 */
export function periodRange(month: number, year: number): { from: Date; to: Date; days: number } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  return { from, to, days: to.getUTCDate() };
}
