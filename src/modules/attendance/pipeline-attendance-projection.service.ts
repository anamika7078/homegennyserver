import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Marker written into `attendance.notes` on every row this service creates, so
 * a projected row is recognisable at a glance in the HR table and in support
 * queries. The authoritative test for "this row is ours" is still
 * `marked_by IS NULL` — see projectRange().
 */
const PROJECTION_MARKER = '[auto: field check-in]';

/**
 * How far back a scheduled run reaches. An RM can approve a shift log days
 * after the fact and payroll for a month is usually run in the first week of
 * the next one, so a window shorter than a full month plus slack would let
 * late approvals miss the payroll they belong to.
 */
const LOOKBACK_DAYS = 45;

/**
 * Window for the frequent pass. Staff check in for today, and HR looks at the
 * daily board expecting to see it — waiting for the nightly run would mean
 * today's attendance only appears tomorrow. Three days rather than one so a
 * check-in near midnight, or a device that syncs late, is still covered.
 */
const RECENT_DAYS = 3;

/**
 * HR-side status for each pipeline attendance status.
 *
 * OVERTIME is a worked day; `attendance` has no overtime concept of its own
 * (EmployeeAttendance carries workingHours, not an overtime flag), so it lands
 * as Present and the overtime hours stay on the pipeline row where the
 * placement-side payroll already reads them.
 */
const STATUS_TO_HR: Record<string, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HALF_DAY: 'Half Day',
  OVERTIME: 'Present',
};

/**
 * Projects field attendance into the HR ledger.
 *
 * Deployed staff mark their own attendance from the mobile app, which lands in
 * `shift_logs` and is reconciled into `staff_daily_attendance`. HR's payroll,
 * however, counts `attendance` (EmployeeAttendance) and nothing else —
 * PayrollService.countAttendanceForEmployee reads that table alone. So a staff
 * member could check in every single day and still have `runEmployeePayroll`
 * refuse with "No billable attendance days for this period".
 *
 * This service copies the pipeline's days across for employees linked to a
 * pipeline record. It is the mirror image of StaffAttendanceMirrorService,
 * which pushes HR's own entries the other way.
 *
 * It never touches a row a human marked. `AttendanceService.mark` always
 * stamps `marked_by` with the acting user, and it is the only writer of that
 * table besides this service — so `marked_by IS NULL` identifies exactly the
 * rows this projection owns and may overwrite. An HR correction wins over the
 * field record permanently, which is the intended precedence: HR correcting a
 * day is a deliberate act, and a later re-run must not silently undo it.
 */
@Injectable()
export class PipelineAttendanceProjectionService {
  private readonly logger = new Logger(PipelineAttendanceProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keeps the last few days current. Cheap enough to run often — the whole
   * projection is a single upsert statement — and it is what makes a staff
   * member's own check-in appear on HR's screens without anyone pressing
   * anything.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async frequentProjection() {
    const to = new Date();
    const from = new Date(to.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.projectRange({ from, to });
    // Silent when there is nothing to do, or this logs 144 no-op lines a day.
    if (result.inserted || result.updated) {
      this.logger.log(
        `[PROJECTION] recent pass: ${result.inserted} inserted, ${result.updated} updated`,
      );
    }
    return result;
  }

  /**
   * The deep pass. Catches an RM approving a shift days late, which the
   * three-day window above would have already moved past.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduledProjection() {
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.projectRange({ from, to });
    this.logger.log(
      `[PROJECTION] daily run: ${result.inserted} inserted, ${result.updated} updated, ${result.skippedManual} left alone (HR-marked)`,
    );
    return result;
  }

  /**
   * Projects one calendar month for one employee, or for every linked employee
   * when `employeeId` is omitted. This is what a payroll run calls so the month
   * being paid is current, rather than waiting for the next nightly pass.
   */
  async projectMonth(params: { month: number; year: number; employeeId?: string }) {
    const from = new Date(Date.UTC(params.year, params.month - 1, 1));
    const to = new Date(Date.UTC(params.year, params.month, 0));
    return this.projectRange({ from, to, employeeId: params.employeeId });
  }

  /**
   * The whole projection is one SQL statement so a run cannot half-apply, and
   * so a month of days for every employee is a single round trip rather than
   * one per day. The join from staff_daily_attendance back to employees via
   * staff_applicant_id is what makes this possible at all — before that column
   * existed there was no way to know which employee a pipeline row belonged to.
   */
  async projectRange(params: { from: Date; to: Date; employeeId?: string }) {
    const fromDate = this.toUtcDateOnly(params.from);
    const toDate = this.toUtcDateOnly(params.to);

    const rows = await this.prisma.$queryRawUnsafe<
      { action: string; count: bigint }[]
    >(
      `
      WITH source AS (
        SELECT e.id            AS employee_id,
               sda.attendance_date,
               CASE sda.status::text
                 WHEN 'PRESENT'  THEN 'Present'
                 WHEN 'ABSENT'   THEN 'Absent'
                 WHEN 'LEAVE'    THEN 'Leave'
                 WHEN 'HALF_DAY' THEN 'Half Day'
                 WHEN 'OVERTIME' THEN 'Present'
               END             AS hr_status
          FROM staff_daily_attendance sda
          JOIN employees e ON e.staff_applicant_id = sda.staff_id
         WHERE e.deleted_at IS NULL
           AND sda.attendance_date BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR e.id = $3::uuid)
      ),
      upserted AS (
        INSERT INTO attendance
          (id, employee_id, date, status, notes, marked_by, created_at, updated_at)
        SELECT gen_random_uuid(), s.employee_id, s.attendance_date, s.hr_status,
               $4, NULL, NOW(), NOW()
          FROM source s
         WHERE s.hr_status IS NOT NULL
        ON CONFLICT (employee_id, date) DO UPDATE
           SET status = EXCLUDED.status,
               notes = EXCLUDED.notes,
               updated_at = NOW()
         -- Only rows this projection owns. A day HR marked by hand keeps the
         -- status HR gave it, no matter what the field record later says.
         WHERE attendance.marked_by IS NULL
        RETURNING (xmax = 0) AS inserted
      )
      SELECT CASE WHEN inserted THEN 'inserted' ELSE 'updated' END AS action,
             COUNT(*) AS count
        FROM upserted
       GROUP BY 1
      `,
      fromDate,
      toDate,
      params.employeeId ?? null,
      PROJECTION_MARKER,
    );

    const counts = Object.fromEntries(rows.map((r) => [r.action, Number(r.count)]));
    const inserted = counts.inserted ?? 0;
    const updated = counts.updated ?? 0;

    // Days present on the pipeline side that the upsert deliberately declined
    // to touch because a human owns them. Reported rather than hidden, so a
    // discrepancy between the two ledgers is visible instead of mysterious.
    const skipped = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `
      SELECT COUNT(*) AS count
        FROM staff_daily_attendance sda
        JOIN employees e ON e.staff_applicant_id = sda.staff_id
        JOIN attendance a ON a.employee_id = e.id AND a.date = sda.attendance_date
       WHERE e.deleted_at IS NULL
         AND sda.attendance_date BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR e.id = $3::uuid)
         AND a.marked_by IS NOT NULL
      `,
      fromDate,
      toDate,
      params.employeeId ?? null,
    );

    return {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      employeeId: params.employeeId ?? null,
      inserted,
      updated,
      skippedManual: Number(skipped[0]?.count ?? 0),
    };
  }

  /** Postgres DATE columns are compared by UTC calendar day here, as everywhere else. */
  private toUtcDateOnly(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
}
