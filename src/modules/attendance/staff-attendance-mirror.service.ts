import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StaffAttendanceStatus } from '@prisma/client';

/**
 * HR marking attendance on a staff member's behalf.
 *
 * Deployed field staff normally mark their own attendance from the mobile app
 * (`POST /staff/attendance/check-in`), which writes a GPS-stamped `shift_logs`
 * row and mirrors it into `staff_daily_attendance` — and `staff_daily_attendance`
 * is what payroll and client invoicing actually count. HR's own screen writes
 * `attendance` (EmployeeAttendance), a completely separate table nothing
 * downstream reads for field staff. So HR marking a day Present had no effect
 * on that person's pay.
 *
 * This service closes that gap: whenever HR marks attendance for an employee
 * who was onboarded out of the pipeline, the same day is written into
 * `staff_daily_attendance` too, exactly as the staff member's own check-in
 * would have. Office employees (no linked applicant) mirror nothing.
 */
@Injectable()
export class StaffAttendanceMirrorService {
  private readonly logger = new Logger(StaffAttendanceMirrorService.name);

  /**
   * HR's labels are richer than the pipeline's enum. 'Late' has no counterpart
   * there — a late arrival is still a worked, billable day, so it maps to
   * PRESENT and the original label is preserved in the note rather than lost.
   */
  private static readonly STATUS_MAP: Record<string, StaffAttendanceStatus> = {
    Present: 'PRESENT',
    Absent: 'ABSENT',
    Leave: 'LEAVE',
    'Half Day': 'HALF_DAY',
    Late: 'PRESENT',
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds the UTC midnight Date that a Postgres `DATE` column expects.
   *
   * Prisma serialises a JS Date to a DATE column by its UTC calendar day, so a
   * local-midnight Date in IST (UTC+5:30) lands on the PREVIOUS day. Verified
   * against this database: new Date(2031, 0, 15) stored as 2031-01-14. Both
   * writers of `staff_daily_attendance` (staff mobile check-in, RM's
   * PUT /rm/attendance) already build UTC midnight, so HR must match them or
   * its rows would land a day off and never collide with the unique
   * [staff_id, attendance_date] key they rely on.
   */
  static toUtcDateOnly(value: string | Date): Date {
    if (value instanceof Date) {
      return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    }
    const [y, m, d] = String(value).split('T')[0].split('-').map(Number);
    if (!y || !m || !d) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(`Invalid date: ${value}`);
      }
      return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }
    return new Date(Date.UTC(y, m - 1, d));
  }

  /**
   * Mirrors one HR-marked day into the pipeline's attendance table.
   *
   * Returns null when there is nothing to mirror (office hire, or a status with
   * no pipeline equivalent). Never throws for a missing placement — HR should
   * still be able to record the day on the HR side.
   */
  async mirror(params: {
    employeeId: string;
    date: string | Date;
    status: string;
    actorId: string;
    notes?: string | null;
    overtimeHours?: number | null;
    /**
     * Allows HR to overwrite the staff member's own live check-in. Off by
     * default: a GPS-stamped self-submission outranks a desk correction, and
     * RM's equivalent endpoint refuses the same case.
     */
    overrideSelfCheckIn?: boolean;
  }) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: params.employeeId, deletedAt: null },
      select: { id: true, branchId: true, staffApplicantId: true, fullName: true },
    });

    // Office / back-office hire — they never went through S1-S5, so there is no
    // pipeline attendance row to keep in step.
    if (!employee?.staffApplicantId) return null;

    const mappedStatus = StaffAttendanceMirrorService.STATUS_MAP[params.status];
    if (!mappedStatus) return null;

    const attendanceDate = StaffAttendanceMirrorService.toUtcDateOnly(params.date);
    const staffId = employee.staffApplicantId;

    // Same rule RM's PUT /rm/attendance enforces: a live self-submission is the
    // staff member's own GPS-backed record of the day and must be reviewed, not
    // silently overwritten from a desk.
    const ownShift = await this.prisma.shiftLog.findUnique({
      where: { staffId_shiftDate: { staffId, shiftDate: attendanceDate } },
      select: { status: true },
    });
    if (ownShift && ownShift.status !== 'REJECTED' && !params.overrideSelfCheckIn) {
      throw new BadRequestException(
        `${employee.fullName} already has a ${ownShift.status.toLowerCase()} self-check-in for this date. ` +
          `Have the RM review it, or resend with overrideSelfCheckIn: true to record HR's version over it.`,
      );
    }

    const placement = await this.prisma.placement.findFirst({
      where: { staffId, status: { in: ['CONFIRMED', 'TRIAL'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, branchId: true },
    });

    const branchId = placement?.branchId ?? employee.branchId;
    if (!branchId) {
      this.logger.warn(
        `[MIRROR] employee ${employee.id} has no placement and no branch — skipping pipeline attendance`,
      );
      return null;
    }

    const note = [
      params.notes?.trim() || null,
      `Marked by HR on behalf of staff (HR status: ${params.status})`,
      ownShift ? `overrode ${ownShift.status.toLowerCase()} self-check-in` : null,
    ]
      .filter(Boolean)
      .join(' — ');

    const record = await this.prisma.staffDailyAttendance.upsert({
      where: { staffId_attendanceDate: { staffId, attendanceDate } },
      create: {
        staffId,
        placementId: placement?.id ?? null,
        branchId,
        attendanceDate,
        status: mappedStatus,
        overtimeHours: params.overtimeHours ?? null,
        markedBy: params.actorId,
        notes: note,
      },
      update: {
        status: mappedStatus,
        placementId: placement?.id ?? null,
        branchId,
        ...(params.overtimeHours !== undefined && params.overtimeHours !== null
          ? { overtimeHours: params.overtimeHours }
          : {}),
        markedBy: params.actorId,
        notes: note,
      },
    });

    this.logger.log(
      `[MIRROR] HR marked ${employee.fullName} ${mappedStatus} on ${attendanceDate.toISOString().slice(0, 10)} (staff ${staffId})`,
    );

    return {
      id: record.id,
      staffId,
      attendanceDate: record.attendanceDate,
      status: record.status,
      placementId: record.placementId,
      overrodeSelfCheckIn: Boolean(ownShift && ownShift.status !== 'REJECTED'),
    };
  }
}
