import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface DepositRow {
  id: string;
  staff_id: string;
  staff_code: string;
  full_name: string;
  series: string;
  amount: string;
  status: string;
  payment_ref: string | null;
  collected_at: string | null;
  event: string | null;
  event_at: string | null;
  event_notes: string | null;
  event_scenario_code: string | null;
  refund_amount: string | null;
  deposit_status: string;
  placement_status: string | null;
  exit_scenario_code: string | null;
  created_at: string;
}

type DepositEvent = 'REFUND' | 'FORFEITURE' | 'PARTIAL_REFUND';

const VALID_EVENTS: DepositEvent[] = ['REFUND', 'FORFEITURE', 'PARTIAL_REFUND'];

/**
 * Reads and writes the `deposits` table — the one intake actually populates
 * (`rm.service.ts` → `prisma.deposit.create`).
 *
 * This service previously queried `staff_applicants.deposit_amount`, a column
 * that defaults to 0 and which nothing in the codebase ever writes, so the
 * Finance console's deposit list, stats and FORFEITED filter all returned
 * empty no matter how many deposits had been collected. Events were likewise
 * written to `staff_applicants.metadata` rather than onto the deposit row they
 * described. See F-05 in docs/FINANCE_MODULE_AUDIT.md.
 */
@Injectable()
export class DepositService {
  constructor(private readonly dataSource: DataSource) {}

  async listDeposits(status?: 'PAID' | 'UNPAID' | 'FORFEITED') {
    let sql = `
      SELECT
        d.id,
        d.staff_id,
        sa.staff_code,
        sa.full_name,
        sa.series,
        d.amount,
        d.status,
        d.payment_ref,
        d.collected_at,
        d.event,
        d.event_at,
        d.event_notes,
        d.event_scenario_code,
        d.refund_amount,
        d.created_at,
        p.status AS placement_status,
        p.exit_scenario_code
      FROM deposits d
      JOIN staff_applicants sa ON sa.id = d.staff_id
      LEFT JOIN LATERAL (
        SELECT status, exit_scenario_code
        FROM placements
        WHERE staff_id = d.staff_id
          AND status IN ('CONFIRMED', 'EXITED', 'TERMINATED')
        ORDER BY created_at DESC
        LIMIT 1
      ) p ON true
      WHERE d.amount > 0
    `;

    if (status === 'PAID') {
      sql += ` AND d.status = 'COLLECTED' AND d.event IS NULL`;
    } else if (status === 'UNPAID') {
      sql += ` AND d.status <> 'COLLECTED'`;
    } else if (status === 'FORFEITED') {
      sql += ` AND d.event = 'FORFEITURE'`;
    }

    sql += ' ORDER BY d.created_at DESC';

    const rows = await this.dataSource.query<DepositRow[]>(sql);

    return rows.map((r) => ({
      ...r,
      deposit_status: this.computeDepositStatus(r),
    }));
  }

  private computeDepositStatus(row: DepositRow): string {
    if (row.event === 'FORFEITURE') return 'FORFEITED';
    if (row.event === 'REFUND') return 'REFUNDED';
    if (row.event === 'PARTIAL_REFUND') return 'PARTIAL_REFUND';
    if (row.status === 'COLLECTED') return 'PAID';
    return 'UNPAID';
  }

  /**
   * Records a refund / forfeiture against the staff member's deposit.
   *
   * Addressed by staff id because that is what the Finance console and the
   * exit flow both hold; a staff member has at most one deposit in practice,
   * and the most recent is the one an exit resolves.
   */
  async recordDepositEvent(
    staffId: string,
    event: DepositEvent,
    notes?: string,
    scenarioCode?: string,
    refundAmount?: number,
    actorId?: string,
  ) {
    if (!VALID_EVENTS.includes(event)) {
      throw new BadRequestException(
        `Unknown deposit event "${event}". Expected one of ${VALID_EVENTS.join(', ')}.`,
      );
    }

    const rows = await this.dataSource.query<{ id: string; amount: string; event: string | null }[]>(
      `SELECT id, amount, event FROM deposits
       WHERE staff_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [staffId],
    );
    if (!rows.length) {
      throw new NotFoundException(
        `No deposit on record for staff ${staffId} — nothing to refund or forfeit.`,
      );
    }

    const deposit = rows[0];
    if (deposit.event) {
      throw new BadRequestException(
        `Deposit ${deposit.id} is already resolved as ${deposit.event}. ` +
        `Reverse it before recording a different outcome.`,
      );
    }

    // A partial refund without an amount is not a record of anything — the
    // whole point of the event is how much went back.
    if (event === 'PARTIAL_REFUND' && (refundAmount == null || refundAmount <= 0)) {
      throw new BadRequestException('PARTIAL_REFUND requires a positive refund_amount.');
    }

    const resolvedRefund =
      event === 'REFUND' ? parseFloat(deposit.amount)
      : event === 'PARTIAL_REFUND' ? refundAmount
      : 0;

    if (resolvedRefund != null && resolvedRefund > parseFloat(deposit.amount)) {
      throw new BadRequestException(
        `Refund of ${resolvedRefund} exceeds the deposit held (${deposit.amount}).`,
      );
    }

    const [updated] = await this.dataSource.query<DepositRow[]>(
      `UPDATE deposits
       SET event = $1,
           event_at = NOW(),
           event_notes = $2,
           event_scenario_code = $3,
           refund_amount = $4,
           recorded_by = $5
       WHERE id = $6
       RETURNING *`,
      [event, notes ?? null, scenarioCode ?? null, resolvedRefund, actorId ?? null, deposit.id],
    );

    return {
      deposit_id: deposit.id,
      staff_id: staffId,
      event,
      refund_amount: resolvedRefund,
      scenario_code: scenarioCode,
      notes,
      recorded_at: updated?.event_at ?? new Date().toISOString(),
    };
  }

  async getDepositStats() {
    const rows = await this.dataSource.query<{
      total_staff: string;
      paid_count: string;
      unpaid_count: string;
      total_collected: string;
      total_outstanding: string;
      total_refunded: string;
      total_forfeited: string;
      refund_due_count: string;
    }[]>(
      `SELECT
        COUNT(*)                                                                    AS total_staff,
        COUNT(*) FILTER (WHERE d.status = 'COLLECTED')                              AS paid_count,
        COUNT(*) FILTER (WHERE d.status <> 'COLLECTED')                             AS unpaid_count,
        COALESCE(SUM(d.amount) FILTER (WHERE d.status = 'COLLECTED'), 0)            AS total_collected,
        COALESCE(SUM(d.amount) FILTER (WHERE d.status <> 'COLLECTED'), 0)           AS total_outstanding,
        COALESCE(SUM(d.refund_amount) FILTER (WHERE d.event IN ('REFUND', 'PARTIAL_REFUND')), 0) AS total_refunded,
        COALESCE(SUM(d.amount) FILTER (WHERE d.event = 'FORFEITURE'), 0)            AS total_forfeited,
        -- Held against a staff member who has already left, with no refund or
        -- forfeiture recorded — this is the number Finance has to act on.
        COUNT(*) FILTER (
          WHERE d.status = 'COLLECTED'
            AND d.event IS NULL
            AND EXISTS (
              SELECT 1 FROM placements p
              WHERE p.staff_id = d.staff_id AND p.status IN ('EXITED', 'TERMINATED')
            )
        )                                                                            AS refund_due_count
       FROM deposits d
       WHERE d.amount > 0`,
    );
    return rows[0];
  }
}
