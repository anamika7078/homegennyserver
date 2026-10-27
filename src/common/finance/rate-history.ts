import type { DataSource, EntityManager } from 'typeorm';
import { isoDate, nextDay } from './period.util';

/**
 * Which rate applied on which day.
 *
 * A placement's rates used to be a single set of columns overwritten in place,
 * and payroll read whatever they said on the day it ran. Every change is now a
 * row in placement_rate_changes with the date it applies from; the active rows
 * (superseded_at null) form one timeline, and payroll prices each day at the
 * rate in force that day.
 *
 * Rule for a day d:
 *   - the latest active change with effective_from ≤ d → its `after`
 *   - none yet (d is before the first change) → the first change's `before`
 *   - no changes at all → null; the placement's own columns apply (as always)
 */

// Anything that runs SQL with positional parameters — a TypeORM DataSource or
// EntityManager, or a thin Prisma adapter.
type Db = DataSource | EntityManager | { query: (sql: string, params?: unknown[]) => Promise<any> };

export interface RateSnapshot {
  rate_basis: string | null;
  staff_salary: number | null;
  management_fee: number | null;
  hourly_rate: number | null;
  hourly_fee: number | null;
  duty_rate: number | null;
  duty_billing_rate: number | null;
  esic_applicable: boolean;
  pf_applicable: boolean;
  /** The agreed wage breakup lives in metadata and drives PF; it is part of the rate. */
  wage_config: unknown;
  wage_breakup: unknown;
}

export interface RateChange {
  id: string;
  effective_from: string;
  before: RateSnapshot;
  after: RateSnapshot;
  reason: string | null;
  source: string;
  changed_by: string | null;
  changed_at: Date;
}

const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** The placement's rates as they stand now. */
export async function currentRates(db: Db, placementId: string): Promise<RateSnapshot | null> {
  const rows = await db.query(
    `SELECT rate_basis, staff_salary, management_fee, hourly_rate, hourly_fee, duty_rate, duty_billing_rate,
            esic_applicable, pf_applicable,
            metadata->'wage_config' AS wage_config, metadata->'wage_breakup' AS wage_breakup
       FROM placements WHERE id = $1::uuid`,
    [placementId],
  ) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    rate_basis: (r.rate_basis as string | null) ?? null,
    staff_salary: n(r.staff_salary),
    management_fee: n(r.management_fee),
    hourly_rate: n(r.hourly_rate),
    hourly_fee: n(r.hourly_fee),
    duty_rate: n(r.duty_rate),
    duty_billing_rate: n(r.duty_billing_rate),
    esic_applicable: r.esic_applicable !== false,
    pf_applicable: r.pf_applicable !== false,
    wage_config: r.wage_config ?? null,
    wage_breakup: r.wage_breakup ?? null,
  };
}

/** The active timeline, oldest effective date first. */
export async function activeChanges(db: Db, placementId: string): Promise<RateChange[]> {
  const rows = await db.query(
    `SELECT id, effective_from::text AS effective_from, before, after, reason, source, changed_by, changed_at
       FROM placement_rate_changes
      WHERE placement_id = $1::uuid AND superseded_at IS NULL
      ORDER BY effective_from, changed_at`,
    [placementId],
  ) as RateChange[];
  return rows;
}

/** Pure: the rate in force on `date`, given the active timeline. Null when there is none. */
export function rateOn(changes: RateChange[], date: string): RateSnapshot | null {
  if (!changes.length) return null;
  let found: RateChange | null = null;
  for (const c of changes) {
    if (c.effective_from <= date) found = c;
    else break;
  }
  return found ? found.after : changes[0].before;
}

export async function ratesAt(db: Db, placementId: string, date: string): Promise<RateSnapshot | null> {
  return rateOn(await activeChanges(db, placementId), date);
}

/**
 * The dates inside (from, to] on which the rate changes — where a payroll
 * period has to be cut so each part is priced at one rate.
 */
export async function changeDatesWithin(db: Db, placementId: string, from: string, to: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT DISTINCT effective_from::text AS d
       FROM placement_rate_changes
      WHERE placement_id = $1::uuid AND superseded_at IS NULL
        AND effective_from > $2::date AND effective_from <= $3::date
      ORDER BY 1`,
    [placementId, from, to],
  ) as { d: string }[];
  return rows.map((r) => r.d);
}

/** Cuts [from, to] at each date in `cuts` (each starts a new part). */
export function splitPeriod(period: { from: string; to: string }, cuts: string[]) {
  const parts: { from: string; to: string }[] = [];
  let start = period.from;
  for (const c of cuts) {
    if (c <= start || c > period.to) continue;
    const dayBefore = isoDate(new Date(new Date(`${c}T00:00:00Z`).getTime() - 86_400_000))!;
    parts.push({ from: start, to: dayBefore });
    start = c;
  }
  parts.push({ from: start, to: period.to });
  return parts;
}

/**
 * Lays a historical rate over a placement row read for payroll (numeric
 * columns arrive as strings from SQL, so they go back as strings).
 */
export function applyRates<T extends object>(row: T, rates: RateSnapshot): T {
  const s = (v: number | null) => (v === null ? null : String(v));
  const meta = ((row as Record<string, unknown>).metadata as Record<string, unknown> | null) ?? {};
  return {
    ...row,
    rate_basis: rates.rate_basis,
    staff_salary: s(rates.staff_salary),
    management_fee: s(rates.management_fee),
    hourly_rate: s(rates.hourly_rate),
    hourly_fee: s(rates.hourly_fee),
    duty_rate: s(rates.duty_rate),
    duty_billing_rate: s(rates.duty_billing_rate),
    esic_applicable: rates.esic_applicable,
    pf_applicable: rates.pf_applicable,
    metadata: { ...meta, wage_config: rates.wage_config ?? undefined, wage_breakup: rates.wage_breakup ?? undefined },
  } as T;
}

/** The first day no live payroll row covers — where a change applies by default. */
export async function firstUnbilledDay(db: Db, placementId: string): Promise<string> {
  const rows = await db.query(
    `SELECT MAX(pr.period_to)::text AS last_to,
            COALESCE(p.trial_start_date, p.confirmed_at::date, p.created_at::date)::text AS start
       FROM placements p
       LEFT JOIN payroll_records pr ON pr.placement_id = p.id
      WHERE p.id = $1::uuid
      GROUP BY p.trial_start_date, p.confirmed_at, p.created_at`,
    [placementId],
  ) as { last_to: string | null; start: string | null }[];
  const r = rows[0];
  if (r?.last_to) return nextDay(r.last_to);
  return r?.start ?? isoDate(new Date())!;
}

/** Which rate fields differ between two snapshots — for history and messages. */
export function changedFields(a: RateSnapshot, b: RateSnapshot): string[] {
  const keys: (keyof RateSnapshot)[] = [
    'rate_basis', 'staff_salary', 'management_fee', 'hourly_rate', 'hourly_fee',
    'duty_rate', 'duty_billing_rate', 'esic_applicable', 'pf_applicable', 'wage_config',
  ];
  return keys.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
}
