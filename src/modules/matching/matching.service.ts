import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CandidateRow {
  id:             string;
  staff_code:     string;
  series:         string;
  language_tier:  string | null;
  pipeline_stage: string;
  role_types:     string[] | null;
}

@Injectable()
export class MatchingService {
  constructor(private readonly dataSource: DataSource) {}

  async findCandidates(requirements: Record<string, unknown>): Promise<CandidateRow[]> {
    const series = requirements['series'] as string;
    return this.dataSource.query<CandidateRow[]>(
      `SELECT sa.id, sa.staff_code, sa.series,
              sa.language_tier, sa.pipeline_stage, sa.role_types
       FROM staff_applicants sa
       WHERE sa.series = $1
         AND sa.pipeline_stage = 'S4_AGREEMENTS'
         AND sa.restricted_list = false
       ORDER BY sa.created_at ASC
       LIMIT 20`,
      [series],
    );
  }
}
