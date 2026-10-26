import { BadRequestException } from '@nestjs/common';

/**
 * Billing periods as plain `YYYY-MM-DD` strings.
 *
 * A client can be invoiced for part of a month and then the rest (1–7, then
 * 8–31). Dates are kept as strings end to end: a JavaScript Date built at
 * local midnight is stored a day early in a Postgres DATE column on this IST
 * server, and that is exactly the off-by-one a billing period cannot have.
 *
 * A period never crosses a month boundary — statutory limits, proration and the
 * salary slip are all monthly — so every helper here works inside one month.
 */

export interface Period {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function daysIn(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthBounds(month: number, year: number): Period {
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(daysIn(month, year))}` };
}

/** "2026-10-07" → "2026-10-08". */
export function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Normalises a DATE column value (string or Date) to `YYYY-MM-DD`. */
export function isoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    // pg hands DATE back as a local-midnight Date; read the local parts.
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Validates a caller-supplied "till" date and that it sits in the month. */
export function parseTillDate(value: unknown, month: number, year: number): string | undefined {
  if (value == null || value === '') return undefined;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException(`to_date must be YYYY-MM-DD, not "${String(value)}".`);
  }
  const b = monthBounds(month, year);
  if (s < b.from || s > b.to) {
    throw new BadRequestException(
      `to_date ${s} is outside ${pad(month)}/${year}. An invoice period stays inside one month — ` +
        `bill the rest of this month first, then the next month separately.`,
    );
  }
  return s;
}

/** "01 Oct – 07 Oct 2026" */
export function formatPeriod(p: Period): string {
  const f = (iso: string, withYear: boolean) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
    });
  };
  return `${f(p.from, false)} – ${f(p.to, true)}`;
}

export const BILLING_CYCLES = ['MONTHLY', 'FORTNIGHTLY', 'WEEKLY', 'MANUAL'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/**
 * Whether a client on this cycle has a billing period ending on `iso`.
 *
 *   MONTHLY      the last day of the month
 *   FORTNIGHTLY  the 15th and the last day
 *   WEEKLY       the 7th, 14th, 21st and the last day (the last week runs
 *                22nd–end, so a period never crosses into the next month)
 *   MANUAL       never
 */
export function cycleEndsOn(cycle: string, iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const last = daysIn(m, y);
  switch (cycle) {
    case 'MONTHLY': return d === last;
    case 'FORTNIGHTLY': return d === 15 || d === last;
    case 'WEEKLY': return d === 7 || d === 14 || d === 21 || d === last;
    default: return false;
  }
}
