import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface DepositRow {
  id: string;
  staff_code: string;
  full_name: string;
  series: string;
  deposit_amount: string;
  deposit_paid: boolean;
  deposit_status: string;
  placement_status: string | null;
  exit_scenario_code: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

type DepositEvent = 'REFUND' | 'FORFEITURE' | 'PARTIAL_REFUND';

@Injectable()
export class DepositService {
  constructor(private readonly dataSource: DataSource) {}

  async listDeposits(status?: 'PAID' | 'UNPAID' | 'FORFEITED') {
    let sql = `
      SELECT
        sa.id,
        sa.staff_code,
        sa.full_name,
        sa.series,
        sa.deposit_amount,
        sa.deposit_paid,
        sa.metadata,
        sa.created_at,
        p.status AS placement_status,
        p.exit_scenario_code
      FROM staff_applicants sa
      LEFT JOIN placements p ON p.staff_id = sa.id AND p.status IN ('CONFIRMED', 'EXITED', 'TERMINATED')
      WHERE sa.deposit_amount > 0
    `;
    const params: unknown[] = [];

    if (status === 'PAID') {
      sql += ` AND sa.deposit_paid = true`;
    } else if (status === 'UNPAID') {
      sql += ` AND sa.deposit_paid = false`;
    } else if (status === 'FORFEITED') {
      sql += ` AND sa.metadata->>'deposit_event' = 'FORFEITURE'`;
    }

    sql += ' ORDER BY sa.created_at DESC';

    const rows = await this.dataSource.query<DepositRow[]>(sql, params);

    // Compute derived status
    return rows.map((r) => ({
      ...r,
      deposit_status: this.computeDepositStatus(r),
    }));
  }

  private computeDepositStatus(row: DepositRow): string {
    const depositEvent = (row.metadata as Record<string, unknown>)?.deposit_event as string | undefined;
    if (depositEvent === 'FORFEITURE') return 'FORFEITED';
    if (depositEvent === 'REFUND')     return 'REFUNDED';
    if (depositEvent === 'PARTIAL_REFUND') return 'PARTIAL_REFUND';
    if (row.deposit_paid) return 'PAID';
    return 'UNPAID';
  }

  async recordDepositEvent(
    staffId: string,
    event: DepositEvent,
    notes?: string,
    scenarioCode?: string,
  ) {
    const rows = await this.dataSource.query<{ id: string; metadata: Record<string, unknown> }[]>(
      `SELECT id, metadata FROM staff_applicants WHERE id = $1`, [staffId],
    );
    if (!rows.length) throw new Error(`Staff ${staffId} not found`);

    const existing = rows[0].metadata ?? {};
    const updated = {
      ...existing,
      deposit_event: event,
      deposit_event_at: new Date().toISOString(),
      deposit_event_notes: notes ?? '',
      deposit_scenario_code: scenarioCode ?? '',
    };

    await this.dataSource.query(
      `UPDATE staff_applicants SET metadata = $1::jsonb WHERE id = $2`,
      [JSON.stringify(updated), staffId],
    );

    return {
      staff_id: staffId,
      event,
      scenario_code: scenarioCode,
      notes,
      recorded_at: new Date().toISOString(),
    };
  }

  async getDepositStats() {
    const rows = await this.dataSource.query<{
      total_staff: string;
      paid_count: string;
      unpaid_count: string;
      total_collected: string;
      total_outstanding: string;
    }[]>(
      `SELECT
        COUNT(*)                                                               AS total_staff,
        COUNT(CASE WHEN deposit_paid = true THEN 1 END)                        AS paid_count,
        COUNT(CASE WHEN deposit_paid = false THEN 1 END)                       AS unpaid_count,
        COALESCE(SUM(CASE WHEN deposit_paid = true THEN deposit_amount END), 0) AS total_collected,
        COALESCE(SUM(CASE WHEN deposit_paid = false THEN deposit_amount END), 0) AS total_outstanding
       FROM staff_applicants WHERE deposit_amount > 0`,
    );
    return rows[0];
  }
}
