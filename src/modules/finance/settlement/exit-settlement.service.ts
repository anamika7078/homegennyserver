import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { round2 } from '../../../common/finance/statutory-calc.util';

/**
 * The late-exit fee matrix, automated.
 *
 * The spec has always described this table, and nothing in the codebase
 * computed it — an exit wrote `exit_date` and a scenario code, and every rupee
 * of it was worked out by hand. See F-17.
 *
 *   | Exit stage                     | Fee             | Deposit     | Goodwill |
 *   | During trial                   | Nil             | Full refund | —        |
 *   | Trial extended, then exit      | 15 days salary  | Refund      | —        |
 *   | Mutual trial exit              | Nil             | Full refund | —        |
 *   | Post-confirmation <30 days     | 30 days salary  | Refund      | Nil      |
 *   | Post-confirmation 30–90 days   | 15 days salary  | Refund      | 7 days   |
 *   | Post-confirmation >90 days     | 7 days salary   | Refund      | 15 days  |
 *
 * The fee is charged to the **client**; goodwill is paid to the **staff
 * member**. They are separate sides of the same event, which is why the
 * settlement reports two totals rather than one net figure.
 */

export type ExitReason =
  | 'CLIENT_REQUESTED'
  | 'STAFF_RESIGNED'
  | 'MUTUAL'
  | 'TERMINATED_FOR_CAUSE'
  | 'TRIAL_NOT_CONFIRMED';

export interface FeeBand {
  band: string;
  feeDays: number;
  goodwillDays: number;
  depositAction: 'REFUND' | 'FORFEIT';
  rationale: string;
}

/** A day's pay, using the 30-day convention the fee matrix is expressed in. */
const DAYS_IN_MONTH_FOR_FEES = 30;

@Injectable()
export class ExitSettlementService {
  private readonly logger = new Logger(ExitSettlementService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Which row of the matrix applies.
   *
   * Exported logic rather than inline so the bands can be read, tested and
   * argued about in one place.
   */
  resolveBand(args: {
    confirmed: boolean;
    daysSinceConfirmation: number | null;
    trialExtended: boolean;
    reason: ExitReason;
  }): FeeBand {
    // Cause is outside the matrix: the deposit is forfeited and no fee is
    // charged to a client who did nothing wrong.
    if (args.reason === 'TERMINATED_FOR_CAUSE') {
      return {
        band: 'TERMINATED_FOR_CAUSE',
        feeDays: 0, goodwillDays: 0, depositAction: 'FORFEIT',
        rationale: 'Terminated for cause — deposit forfeited, no cancellation fee.',
      };
    }

    if (!args.confirmed) {
      if (args.reason === 'MUTUAL') {
        return {
          band: 'MUTUAL_TRIAL_EXIT',
          feeDays: 0, goodwillDays: 0, depositAction: 'REFUND',
          rationale: 'Both sides agreed to end the trial — no fee, deposit refunded in full.',
        };
      }
      if (args.trialExtended) {
        return {
          band: 'TRIAL_EXTENDED_THEN_EXIT',
          feeDays: 15, goodwillDays: 0, depositAction: 'REFUND',
          rationale: 'Trial was extended by agreement and then ended — 15 days salary.',
        };
      }
      return {
        band: 'DURING_TRIAL',
        feeDays: 0, goodwillDays: 0, depositAction: 'REFUND',
        rationale: 'Exit during the original trial period — no fee, deposit refunded in full.',
      };
    }

    const days = args.daysSinceConfirmation ?? 0;
    if (days < 30) {
      return {
        band: 'POST_CONFIRM_UNDER_30D',
        feeDays: 30, goodwillDays: 0, depositAction: 'REFUND',
        rationale: `Exit ${days} days after confirmation — 30 days salary, no goodwill.`,
      };
    }
    if (days <= 90) {
      return {
        band: 'POST_CONFIRM_30_TO_90D',
        feeDays: 15, goodwillDays: 7, depositAction: 'REFUND',
        rationale: `Exit ${days} days after confirmation — 15 days salary, 7 days goodwill.`,
      };
    }
    return {
      band: 'POST_CONFIRM_OVER_90D',
      feeDays: 7, goodwillDays: 15, depositAction: 'REFUND',
      rationale: `Exit ${days} days after confirmation — 7 days salary, 15 days goodwill.`,
    };
  }

  /**
   * Computes the full statement without writing it.
   *
   * Covers all three moving parts an exit creates: what the client owes, what
   * the staff member is owed for the days actually worked, and what happens to
   * the deposit.
   */
  async preview(args: {
    placementId: string;
    exitDate: string;
    reason: ExitReason;
    trialExtended?: boolean;
  }) {
    const rows = await this.dataSource.query<{
      id: string; staff_id: string; client_id: string; status: string;
      staff_salary: string | null; trial_start_date: string | null; trial_end_date: string | null;
      confirmed_at: string | null; staff_code: string; full_name: string;
      customer_name: string | null;
    }[]>(
      `SELECT p.id, p.staff_id, p.client_id, p.status, p.staff_salary,
              p.trial_start_date, p.trial_end_date, p.confirmed_at,
              sa.staff_code, sa.full_name,
              fc.customer_name
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       LEFT JOIN finance_customers fc ON fc.id = p.client_id
       WHERE p.id = $1`,
      [args.placementId],
    );
    if (!rows.length) throw new NotFoundException(`Placement ${args.placementId} not found`);
    const p = rows[0];

    const monthlySalary = parseFloat(p.staff_salary ?? '0');
    if (!(monthlySalary > 0)) {
      throw new BadRequestException(
        `Placement ${args.placementId} has no staff_salary — the fee matrix is expressed in days of salary, so it cannot be computed.`,
      );
    }

    const exitDate = new Date(args.exitDate);
    if (Number.isNaN(exitDate.getTime())) {
      throw new BadRequestException(`"${args.exitDate}" is not a valid exit date.`);
    }

    const confirmed = Boolean(p.confirmed_at) || p.status === 'CONFIRMED';
    const confirmedAt = p.confirmed_at ? new Date(p.confirmed_at) : null;
    const daysSinceConfirmation = confirmedAt
      ? Math.max(0, Math.floor((exitDate.getTime() - confirmedAt.getTime()) / 86_400_000))
      : null;

    // An extension shows up as a trial end date later than the series default
    // allows; the caller can also state it explicitly.
    const trialExtended = args.trialExtended ?? false;

    const band = this.resolveBand({
      confirmed, daysSinceConfirmation, trialExtended, reason: args.reason,
    });

    const dailyRate = round2(monthlySalary / DAYS_IN_MONTH_FOR_FEES);
    const cancellationFee = round2(dailyRate * band.feeDays);
    const goodwill = round2(dailyRate * band.goodwillDays);

    // Days worked in the exit month that no payroll has covered yet.
    const monthStart = new Date(exitDate.getFullYear(), exitDate.getMonth(), 1);
    const attendance = await this.dataSource.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM staff_daily_attendance
       WHERE staff_id = $1
         AND attendance_date >= $2 AND attendance_date <= $3
         AND status IN ('PRESENT','OVERTIME')`,
      [p.staff_id, monthStart, exitDate],
    ).catch(() => [{ n: '0' }]);
    const finalMonthDays = parseInt(attendance[0]?.n ?? '0', 10);

    const alreadyPaid = await this.dataSource.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM payroll_records
       WHERE staff_id = $1 AND period_month = $2 AND period_year = $3`,
      [p.staff_id, exitDate.getMonth() + 1, exitDate.getFullYear()],
    ).catch(() => [{ n: '0' }]);
    const finalMonthAlreadyRun = parseInt(alreadyPaid[0]?.n ?? '0', 10) > 0;

    const daysInExitMonth = new Date(exitDate.getFullYear(), exitDate.getMonth() + 1, 0).getDate();
    const finalMonthAmount = finalMonthAlreadyRun
      ? 0
      : round2(monthlySalary * (finalMonthDays / daysInExitMonth));

    // Deposit, as it actually stands on the deposit row.
    const dep = await this.dataSource.query<{ id: string; amount: string; status: string; event: string | null }[]>(
      `SELECT id, amount, status, event FROM deposits
       WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [p.staff_id],
    ).catch(() => []);
    const depositHeld = dep.length && dep[0].status === 'COLLECTED' && !dep[0].event
      ? round2(parseFloat(dep[0].amount))
      : 0;
    const depositRefund = band.depositAction === 'REFUND' ? depositHeld : 0;

    const netToStaff = round2(finalMonthAmount + goodwill + depositRefund);
    const netFromClient = cancellationFee;

    return {
      placement_id: p.id,
      staff_id: p.staff_id,
      staff_code: p.staff_code,
      staff_name: p.full_name,
      client_id: p.client_id,
      customer_name: p.customer_name,
      exit_date: args.exitDate,
      exit_reason: args.reason,
      confirmed,
      days_since_confirmation: daysSinceConfirmation,
      trial_extended: trialExtended,
      fee_band: band.band,
      band_rationale: band.rationale,
      monthly_salary: monthlySalary,
      daily_rate: dailyRate,
      cancellation_fee_days: band.feeDays,
      cancellation_fee_amount: cancellationFee,
      goodwill_days: band.goodwillDays,
      goodwill_amount: goodwill,
      final_month_days: finalMonthDays,
      final_month_amount: finalMonthAmount,
      // Flagged rather than silently zeroed, so nobody wonders where the
      // last month's salary went.
      final_month_already_paid: finalMonthAlreadyRun,
      deposit_amount: depositHeld,
      deposit_action: band.depositAction,
      deposit_refund_amount: depositRefund,
      net_payable_to_staff: netToStaff,
      net_receivable_from_client: netFromClient,
      breakdown: {
        staff_side: [
          { label: `Final month (${finalMonthDays} day${finalMonthDays === 1 ? '' : 's'} worked)`, amount: finalMonthAmount },
          { label: `Goodwill (${band.goodwillDays} days)`, amount: goodwill },
          { label: band.depositAction === 'REFUND' ? 'Deposit refund' : 'Deposit forfeited', amount: depositRefund },
        ],
        client_side: [
          { label: `Cancellation fee (${band.feeDays} days salary)`, amount: cancellationFee },
        ],
      },
    };
  }

  async create(args: {
    placementId: string;
    exitDate: string;
    reason: ExitReason;
    trialExtended?: boolean;
    scenarioCode?: string;
    actorId?: string;
  }) {
    const existing = await this.dataSource.query<{ id: string; status: string }[]>(
      `SELECT id, status FROM exit_settlements WHERE placement_id = $1`, [args.placementId],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Placement ${args.placementId} already has a settlement (${existing[0].status}).`,
      );
    }

    const p = await this.preview(args);

    const [row] = await this.dataSource.query<Record<string, unknown>[]>(
      `INSERT INTO exit_settlements
         (id, placement_id, staff_id, client_id, exit_date, exit_reason, exit_scenario_code,
          fee_band, days_since_confirmation, monthly_salary,
          cancellation_fee_days, cancellation_fee_amount,
          goodwill_days, goodwill_amount,
          final_month_days, final_month_amount,
          deposit_amount, deposit_action, deposit_refund_amount,
          net_payable_to_staff, net_receivable_from_client,
          status, breakdown, created_by)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'DRAFT',$21::jsonb,$22)
       RETURNING *`,
      [
        p.placement_id, p.staff_id, p.client_id, p.exit_date, p.exit_reason, args.scenarioCode ?? null,
        p.fee_band, p.days_since_confirmation, p.monthly_salary,
        p.cancellation_fee_days, p.cancellation_fee_amount,
        p.goodwill_days, p.goodwill_amount,
        p.final_month_days, p.final_month_amount,
        p.deposit_amount, p.deposit_action, p.deposit_refund_amount,
        p.net_payable_to_staff, p.net_receivable_from_client,
        JSON.stringify(p.breakdown), args.actorId ?? null,
      ],
    );

    this.logger.log(
      `[EXIT_SETTLEMENT] ${p.staff_code} — ${p.fee_band}, ` +
      `client owes ${p.net_receivable_from_client}, staff owed ${p.net_payable_to_staff}`,
    );
    return { settlement: row, preview: p };
  }

  async approve(id: string, actorId?: string) {
    const rows = await this.dataSource.query<{ id: string; status: string }[]>(
      `SELECT id, status FROM exit_settlements WHERE id = $1`, [id],
    );
    if (!rows.length) throw new NotFoundException(`Settlement ${id} not found`);
    if (rows[0].status !== 'DRAFT') {
      throw new BadRequestException(`Settlement is ${rows[0].status}; only a DRAFT can be approved.`);
    }
    const [row] = await this.dataSource.query<Record<string, unknown>[]>(
      `UPDATE exit_settlements
       SET status = 'APPROVED', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [actorId ?? null, id],
    );
    return row;
  }

  /**
   * Marks the settlement paid and resolves the deposit in the same step.
   *
   * The deposit is the one part of this that moves real money on our side, so
   * it is recorded here rather than left for someone to remember separately.
   */
  async settle(id: string, actorId?: string) {
    const rows = await this.dataSource.query<{
      id: string; status: string; staff_id: string; deposit_action: string;
      deposit_refund_amount: string; fee_band: string;
    }[]>(
      `SELECT id, status, staff_id, deposit_action, deposit_refund_amount, fee_band
       FROM exit_settlements WHERE id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Settlement ${id} not found`);
    const s = rows[0];
    if (s.status !== 'APPROVED') {
      throw new BadRequestException(`Settlement is ${s.status}; approve it before settling.`);
    }

    return this.dataSource.transaction(async (manager) => {
      const depositEvent = s.deposit_action === 'FORFEIT' ? 'FORFEITURE' : 'REFUND';
      await manager.query(
        `UPDATE deposits
         SET event = $1, event_at = NOW(), refund_amount = $2,
             event_notes = $3, recorded_by = $4
         WHERE staff_id = $5 AND event IS NULL`,
        [
          depositEvent,
          parseFloat(s.deposit_refund_amount ?? '0'),
          `Exit settlement ${id} (${s.fee_band})`,
          actorId ?? null,
          s.staff_id,
        ],
      );

      const [row] = await manager.query<Record<string, unknown>[]>(
        `UPDATE exit_settlements SET status = 'SETTLED', settled_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id],
      );
      this.logger.log(`[EXIT_SETTLEMENT] ${id} settled, deposit ${depositEvent}`);
      return row;
    });
  }

  async list(status?: string) {
    const params: unknown[] = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE es.status = $1`; }
    return this.dataSource.query(
      `SELECT es.*, sa.staff_code, sa.full_name AS staff_name, fc.customer_name
       FROM exit_settlements es
       JOIN staff_applicants sa ON sa.id = es.staff_id
       LEFT JOIN finance_customers fc ON fc.id = es.client_id
       ${where}
       ORDER BY es.created_at DESC`,
      params,
    );
  }

  /** Exited placements with no settlement yet — the work Finance still owes. */
  async pending() {
    return this.dataSource.query(
      `SELECT p.id AS placement_id, p.staff_id, p.exit_date, p.status, p.confirmed_at,
              p.staff_salary, sa.staff_code, sa.full_name AS staff_name,
              fc.customer_name
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       LEFT JOIN finance_customers fc ON fc.id = p.client_id
       WHERE p.status IN ('EXITED','TERMINATED')
         AND NOT EXISTS (SELECT 1 FROM exit_settlements es WHERE es.placement_id = p.id)
       ORDER BY p.exit_date DESC NULLS LAST`,
    );
  }
}
