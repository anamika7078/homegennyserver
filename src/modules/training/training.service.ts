import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, resolveStaffScope } from '../../common/guards/branch-scope.util';
import { SchemaBootstrapService } from '../health/schema-bootstrap.service';

const CURRICULUM_DAYS: Record<string, number> = {
  DR: 5, DRIVER: 5, SC: 7, SKILLED_CARE: 7,
  UC: 5, UNSKILLED_CARE: 5, M3X: 3, MAID: 3,
};

function seriesAlias(s: string): string {
  return ({ DRIVER: 'DR', SKILLED_CARE: 'SC', UNSKILLED_CARE: 'UC', MAID: 'M3X' } as Record<string, string>)[s] ?? s;
}

function scenarioCode(series: string): string {
  const s = seriesAlias(series);
  return ({ DR: 'DR-14', SC: 'SC-10', UC: 'UC-07', M3X: 'M3X-07' } as Record<string, string>)[s] ?? 'S3';
}

function genBatchCode(series: string): string {
  const s = seriesAlias(series);
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(Math.random() * 90 + 10);
  return `TRN-${s}-${now.getFullYear()}-${month}${rand}`;
}

function mapBatch(r: any) {
  const series = seriesAlias(r.series ?? r.batch_code?.split('-')[1] ?? 'DR');
  const enrollments = (typeof r.enrollments === 'string' ? JSON.parse(r.enrollments) : r.enrollments) ?? [];
  return {
    id: r.id,
    batchCode: r.batch_code,
    series,
    trainerName: r.trainer_name ?? null,
    classroom: r.classroom ?? null,
    startDate: r.start_date,
    status: r.status ?? 'UPCOMING',
    scenarioCode: scenarioCode(r.series),
    curriculumDays: CURRICULUM_DAYS[series] ?? 5,
    enrollments,
  };
}

@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);
  private tablesReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schemaBootstrap: SchemaBootstrapService,
  ) {}

  private ensureTables(): Promise<void> {
    if (!this.tablesReady) {
      this.tablesReady = this.schemaBootstrap.ensureModuleTables();
    }
    return this.tablesReady;
  }

  private branchFilter(scope: { branchId?: string }, alias = ''): string {
    if (!scope.branchId) return '';
    const col = alias ? `${alias}.branch_id` : 'branch_id';
    return `AND ${col} = '${scope.branchId}'::uuid`;
  }

  async listBatches(user: AuthUser) {
    await this.ensureTables();
    const scope = resolveStaffScope(user, {});

    try {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT
        b.id, b.batch_code, b.series, b.trainer_name, b.classroom,
        b.start_date, b.status, b.branch_id, b.rm_id, b.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'staffId', e.staff_id::text,
              'attendance', e.attendance,
              'staffCode', sa.staff_code,
              'fullName', sa.full_name,
              'series', sa.series::text
            ) ORDER BY sa.full_name
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS enrollments
      FROM training_batches b
      LEFT JOIN batch_enrollments e ON e.batch_id = b.id
      LEFT JOIN staff_applicants sa ON sa.id = e.staff_id
      WHERE 1=1 ${this.branchFilter(scope, 'b')}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);

    const filtered = scope.rmId
      ? rows.filter((r) => !r.rm_id || r.rm_id === scope.rmId)
      : rows;

    return filtered.map(mapBatch);
    } catch (err) {
      this.logger.warn(`listBatches: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async createBatch(user: AuthUser, body: Record<string, unknown>) {
    await this.ensureTables();
    const series = String(body.series ?? 'DR');
    const code = genBatchCode(series);
    const startDate = body.start_date ? new Date(String(body.start_date)) : new Date();
    const trainerName = body.trainer_name ? String(body.trainer_name) : null;
    const classroom = body.classroom ? String(body.classroom) : null;
    const branchId = user.branchId ?? null;
    const rmId = user.id;

    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      INSERT INTO training_batches (batch_code, series, trainer_name, classroom, start_date, status, branch_id, rm_id)
      VALUES ($1, $2, $3, $4, $5, 'UPCOMING', ${branchId ? `'${branchId}'::uuid` : 'NULL'}, $6::uuid)
      RETURNING id, batch_code, series, trainer_name, classroom, start_date, status
    `, code, series, trainerName, classroom, startDate, rmId);

    const batch = rows[0];
    return { ...mapBatch(batch), enrollments: [] };
  }

  async enrollStaff(batchId: string, staffId: string) {
    await this.ensureTables();
    const batches = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM training_batches WHERE id = $1::uuid`, batchId,
    );
    if (!batches.length) throw new NotFoundException('Batch not found');

    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO batch_enrollments (batch_id, staff_id, attendance)
       VALUES ($1::uuid, $2::uuid, '{}')
       ON CONFLICT (batch_id, staff_id) DO NOTHING`,
      batchId, staffId,
    );
    return { success: true };
  }

  async markAttendance(batchId: string, staffId: string, dayNumber: number, attended: boolean) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, attendance FROM batch_enrollments WHERE batch_id = $1::uuid AND staff_id = $2::uuid`,
      batchId, staffId,
    );
    if (!rows.length) throw new NotFoundException('Enrollment not found');

    let att: number[] = rows[0].attendance ?? [];
    att = attended
      ? [...new Set([...att, dayNumber])].sort((a, b) => a - b)
      : att.filter((d) => d !== dayNumber);

    // PostgreSQL array literal
    const arrLiteral = `{${att.join(',')}}`;
    await this.prisma.$executeRawUnsafe(
      `UPDATE batch_enrollments SET attendance = $1::integer[] WHERE batch_id = $2::uuid AND staff_id = $3::uuid`,
      arrLiteral, batchId, staffId,
    );
    return { batchId, staffId, attendance: att };
  }

  async updateBatchStatus(batchId: string, status: string) {
    const allowed = ['UPCOMING', 'ACTIVE', 'COMPLETED'];
    const s = status.toUpperCase();
    if (!allowed.includes(s)) throw new BadRequestException(`Status must be one of: ${allowed.join(', ')}`);
    await this.prisma.$executeRawUnsafe(
      `UPDATE training_batches SET status = $1, updated_at = now() WHERE id = $2::uuid`, s, batchId,
    );
    return { success: true, status: s };
  }

  async getStats(user: AuthUser) {
    await this.ensureTables();
    const scope = resolveStaffScope(user, {});

    try {
    const counts = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'ACTIVE')    AS active,
        COUNT(*) FILTER (WHERE status = 'UPCOMING')  AS upcoming,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        COUNT(*) AS total
      FROM training_batches WHERE 1=1 ${this.branchFilter(scope)}
    `);

    const trainees = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) AS total
      FROM batch_enrollments e
      JOIN training_batches b ON b.id = e.batch_id
      WHERE 1=1 ${this.branchFilter(scope, 'b')}
    `);

    const c = counts[0] ?? {};
    return {
      active: Number(c.active ?? 0),
      upcoming: Number(c.upcoming ?? 0),
      completed: Number(c.completed ?? 0),
      total: Number(c.total ?? 0),
      totalTrainees: Number(trainees[0]?.total ?? 0),
    };
    } catch (err) {
      this.logger.warn(`getStats: ${err instanceof Error ? err.message : String(err)}`);
      return { active: 0, upcoming: 0, completed: 0, total: 0, totalTrainees: 0 };
    }
  }
}
