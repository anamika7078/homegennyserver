import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Export the interface so the controller can use it in return type annotations
export interface PlacementRow {
  id: string;
  staff_id: string;
  client_id: string;
  status: string;
  staff_salary: string;
  management_fee: string;
  trial_start_date: string | null;
  trial_end_date: string | null;
  billing_start_date: string | null;
  exit_date: string | null;
  exit_scenario_code: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface PlacementList {
  items: PlacementRow[];
  total: number;
}

interface CountRow { count: string; }

@Injectable()
export class PlacementService {
  constructor(private readonly dataSource: DataSource) {}

  async create(data: Record<string, unknown>): Promise<PlacementRow> {
    const [row] = await this.dataSource.query<PlacementRow[]>(
      `INSERT INTO placements
         (staff_id, client_id, branch_id, rm_id, status,
          staff_salary, management_fee, trial_start_date, trial_end_date)
       VALUES ($1,$2,$3,$4,'TRIAL',$5,$6,$7,$8) RETURNING *`,
      [
        data['staff_id'], data['client_id'],
        data['branch_id'], data['rm_id'],
        data['staff_salary'], data['management_fee'],
        data['trial_start_date'] ?? null,
        data['trial_end_date']   ?? null,
      ],
    );
    return row;
  }

  async findAll(params: { limit: number; offset: number }): Promise<PlacementList> {
    const items = await this.dataSource.query<PlacementRow[]>(
      `SELECT p.*, sa.staff_code, sa.series
       FROM placements p
       JOIN staff_applicants sa ON sa.id = p.staff_id
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [params.limit, params.offset],
    );
    const [countRow] = await this.dataSource.query<CountRow[]>(
      `SELECT COUNT(*) AS count FROM placements`,
    );
    return { items, total: parseInt(countRow.count, 10) };
  }

  async exit(
    id: string,
    data: { exit_date: string; exit_scenario_code: string },
  ): Promise<{ success: boolean }> {
    await this.dataSource.query(
      `UPDATE placements
       SET status = 'EXITED',
           exit_date = $1,
           exit_scenario_code = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [data.exit_date, data.exit_scenario_code, id],
    );
    return { success: true };
  }
}
