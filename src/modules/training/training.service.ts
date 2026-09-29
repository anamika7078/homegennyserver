import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, resolveStaffScope } from '../../common/guards/branch-scope.util';
import { SchemaBootstrapService } from '../health/schema-bootstrap.service';
import * as crypto from 'crypto';

/** A trainee must be added within this long of the batch being created — after
 *  that the window is closed and a new batch has to be made for them instead. */
const ENROLLMENT_WINDOW_HOURS = 24;

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
  // Was `month + 2-digit random` — only 90 possible codes per series/month,
  // so a busy month collided in real testing (batch_code is UNIQUE and the
  // insert wasn't caught, so a collision surfaced as a bare 500). 5-digit
  // random suffix (90,000 possibilities) makes that collision negligible on
  // its own; createBatch() below also retries once on an actual duplicate.
  const rand = Math.floor(Math.random() * 90000 + 10000);
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
    trainerId: r.trainer_id ?? null,
    classroom: r.classroom ?? null,
    startDate: r.start_date,
    endDate: r.end_date ?? null,
    quizDate: r.quiz_date ?? null,
    status: r.status ?? 'UPCOMING',
    scenarioCode: scenarioCode(r.series),
    createdAt: r.created_at,
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

  private async ensureTables(): Promise<void> {
    try {
      if (!this.tablesReady) {
        this.tablesReady = this.schemaBootstrap.ensureModuleTables().catch((err) => {
          this.tablesReady = null;
          throw err;
        });
      }
      await this.tablesReady;
    } catch (err) {
      this.logger.warn(
        `ensureTables: ${err instanceof Error ? err.message : String(err)} — continuing (tables may already exist)`,
      );
    }
  }

  private branchFilter(scope: { branchId?: string }, alias = ''): string {
    if (!scope.branchId) return '';
    const col = alias ? `${alias}.branch_id` : 'branch_id';
    return `AND ${col} = '${scope.branchId}'::uuid`;
  }

  async listBatches(user: AuthUser) {
    await this.ensureTables();
    const scope = resolveStaffScope(user, {});

    try {    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT
        b.id, b.batch_code, b.series, b.trainer_name, b.trainer_id, b.classroom,
        b.start_date, b.end_date, b.quiz_date, b.status, b.branch_id, b.rm_id, b.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'staffId', e.staff_id::text,
              'staffCode', COALESCE(emp.employee_id, sa.staff_code, 'N/A'),
              'fullName', COALESCE(emp.full_name, sa.full_name, 'Unknown'),
              'mobile', COALESCE(emp.mobile, sa.mobile, ''),
              'department', COALESCE(emp.department, sa.series::text, ''),
              'designation', COALESCE(emp.designation, sa.series::text, '')
            ) ORDER BY COALESCE(emp.full_name, sa.full_name)
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS enrollments
      FROM training_batches b
      LEFT JOIN batch_enrollments e ON e.batch_id = b.id
      LEFT JOIN employees emp ON emp.id = e.staff_id AND emp.deleted_at IS NULL
      LEFT JOIN staff_applicants sa ON sa.id = e.staff_id AND sa.deleted_at IS NULL
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
    // `AuthUser` (the JWT payload) only ever carries id/role/branchId — it
    // never had a name to fall back to, so this silently produced the literal
    // string "Staff Trainer" for every batch a TRAINER created for themselves
    // without the caller passing trainer_name explicitly. Look the real name
    // up from `users` in that case instead of guessing at fields that don't exist.
    let trainerName = body.trainerName ?? body.trainer_name;
    if (!trainerName) {
      const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { fullName: true } });
      trainerName = row?.fullName ?? 'Staff Trainer';
    }
    trainerName = String(trainerName);
    const trainerId = String(body.trainerId ?? body.trainer_id ?? user.id);
    const classroom = String(body.classroom ?? 'Main Hall');
    const startDate = String(body.startDate ?? body.start_date ?? new Date().toISOString().slice(0, 10));
    // No more fixed per-series curriculum length — the trainer decides how
    // long THIS batch runs, so there's no sensible default to fall back to.
    const endDateRaw = body.endDate ?? body.end_date;
    if (!endDateRaw) {
      throw new BadRequestException('end_date is required — how long this batch runs is the trainer\'s call now, not a fixed per-series length.');
    }
    const endDate = String(endDateRaw);
    if (endDate < startDate) {
      throw new BadRequestException(`end_date (${endDate}) can't be before start_date (${startDate}).`);
    }
    const quizDateRaw = body.quizDate ?? body.quiz_date;
    const quizDate = quizDateRaw ? String(quizDateRaw) : null;
    const status = String(body.status ?? 'UPCOMING');
    // resolveStaffScope() only fills branchId/rmId in for the RM/BM cases —
    // for any other creator (TRAINER, ADMIN) both silently fell through to
    // null, and getAssignedBatches()'s `AND b.branch_id = '<trainer's own
    // branch>'` can never match a NULL row. A batch a Trainer created via
    // their own "Add Batch" screen would save fine, appear immediately from
    // the create response, then vanish on the next real fetch (reload).
    // Falling back to the acting user's own branchId/id covers that case
    // without touching the RM/BM resolution, which already worked.
    const branchId = body.branchId ?? body.branch_id ?? resolveStaffScope(user, {}).branchId ?? user.branchId ?? null;
    const rmId = body.rmId ?? body.rm_id ?? resolveStaffScope(user, {}).rmId ?? (user.role === 'TRAINER' ? user.id : null);

    // batch_code is UNIQUE and genBatchCode() is random — a collision wasn't
    // caught anywhere, so it surfaced as a bare 500 on POST /training/batches
    // (confirmed live: 8+ batches already existed for one series this month
    // against a 90-code keyspace). Wider keyspace above makes it rare; retry
    // a few times on the specific unique-violation as a backstop instead of
    // trusting randomness alone.
    let res: any[] | undefined;
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      code = genBatchCode(series);
      try {
        res = await this.prisma.$queryRawUnsafe<any[]>(
          `INSERT INTO training_batches (id, batch_code, series, trainer_name, trainer_id, classroom, start_date, end_date, quiz_date, status, branch_id, rm_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::uuid, $5, $6::date, $7::date, $8::date, $9, $10::uuid, $11::uuid, now(), now())
           RETURNING id, created_at`,
          code, series, trainerName, trainerId, classroom, startDate, endDate, quizDate, status, branchId, rmId,
        );
        break;
      } catch (err: any) {
        // $queryRawUnsafe wraps the real Postgres error — err.code is
        // Prisma's generic 'P2010' ("raw query failed"), the actual
        // unique-violation code (23505) and constraint detail live under
        // err.meta. Confirmed the exact shape by reproducing this collision
        // directly against Prisma before writing this check.
        const isBatchCodeCollision =
          err?.meta?.code === '23505' && String(err?.meta?.message ?? '').includes('batch_code');
        if (!isBatchCodeCollision || attempt === 4) throw err;
      }
    }

    return {
      success: true,
      batch: {
        id: res![0].id,
        batchCode: code,
        series,
        trainerName,
        classroom,
        startDate,
        endDate,
        quizDate,
        status,
        createdAt: res![0].created_at,
        enrollments: [],
      },
    };
  }

  async enrollStaff(batchId: string, staffId: string) {
    await this.ensureTables();
    if (!batchId || batchId === 'undefined' || !batchId.match(/^[0-9a-fA-F-]{36}$/)) {
      throw new BadRequestException('Invalid batch ID');
    }
    const batches = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, start_date, created_at FROM training_batches WHERE id = $1::uuid`, batchId,
    ).catch(() => []);
    if (!batches.length) throw new NotFoundException('Batch not found');
    const batchStartDate = batches[0].start_date;

    // Enrollment window: a trainee can only be added within
    // ENROLLMENT_WINDOW_HOURS of the batch's own creation. Past that, this
    // batch is closed to new additions — make a new one instead. This is
    // about how long the ROSTER stays open, not the training dates
    // themselves (start_date/end_date), which don't move.
    const ageMs = Date.now() - new Date(batches[0].created_at).getTime();
    const ageHours = ageMs / (60 * 60 * 1000);
    if (ageHours > ENROLLMENT_WINDOW_HOURS) {
      throw new BadRequestException(
        `This batch's enrollment window closed ${Math.floor(ageHours - ENROLLMENT_WINDOW_HOURS)}h ago ` +
          `(batches accept new trainees for ${ENROLLMENT_WINDOW_HOURS}h after creation). Create a new batch instead.`,
      );
    }

    // batch_enrollments.staff_id FKs to staff_applicants ONLY — never to
    // employees. This used to check employees FIRST and accept a match there
    // as good enough, so an id that only existed in employees (an HR record,
    // not an S1-S5 pipeline candidate) passed this check and then blew up the
    // INSERT below with a raw 23503 foreign-key-violation 500. The frontend's
    // trainee picker already filters to S3_TRAIN staff_applicants, but that
    // was never a real guarantee — this is the actual gate.
    const staffRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, full_name FROM staff_applicants WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`, staffId,
    ).catch(() => []);
    if (!staffRows.length) {
      const empRows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM employees WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1`, staffId,
      ).catch(() => []);
      if (empRows.length) {
        throw new BadRequestException(
          'This id is an HR employee record, not an S1-S5 pipeline trainee — it can\'t be enrolled in a training batch.',
        );
      }
      throw new NotFoundException('Staff applicant not found');
    }

    const existingInSameBatch = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM batch_enrollments WHERE batch_id = $1::uuid AND staff_id = $2::uuid`, batchId, staffId
    );
    if (existingInSameBatch.length > 0) {
      throw new ConflictException('Employee is already added to this batch.');
    }

    const existingOnSameDate = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT be.id FROM batch_enrollments be
       JOIN training_batches tb ON be.batch_id = tb.id
       WHERE be.staff_id = $1::uuid AND tb.start_date = $2::date`, staffId, batchStartDate
    );
    if (existingOnSameDate.length > 0) {
      throw new ConflictException('Employee is already enrolled in another batch on the same date.');
    }

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO batch_enrollments (id, batch_id, staff_id, attendance)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '{}')`,
      batchId, staffId,
    );
    return { success: true, employeeName: staffRows[0].full_name };
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

  /**
   * Lets the trainer move the end date or quiz date after the batch already
   * exists — unlike the 24h enrollment window, there's no deadline on this;
   * a cohort's dates can slip without forcing a whole new batch.
   */
  async updateBatchSchedule(batchId: string, body: { end_date?: string; quiz_date?: string }) {
    const batches = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT start_date, end_date, quiz_date FROM training_batches WHERE id = $1::uuid`, batchId,
    );
    if (!batches.length) throw new NotFoundException('Batch not found');
    const current = batches[0];

    const endDate = body.end_date ? String(body.end_date) : current.end_date;
    const quizDate = body.quiz_date !== undefined ? (body.quiz_date ? String(body.quiz_date) : null) : current.quiz_date;
    if (endDate < current.start_date) {
      throw new BadRequestException(`end_date (${endDate}) can't be before this batch's start_date (${current.start_date}).`);
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE training_batches SET end_date = $1::date, quiz_date = $2::date, updated_at = now() WHERE id = $3::uuid`,
      endDate, quizDate, batchId,
    );
    return { success: true, endDate, quizDate };
  }

  async deleteBatch(batchId: string) {
    await this.ensureTables();
    const batches = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM training_batches WHERE id = $1::uuid`, batchId,
    );
    if (!batches.length) throw new NotFoundException('Batch not found');
    
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM training_batches WHERE id = $1::uuid`, batchId,
    );
    return { success: true };
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
