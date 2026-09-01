import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The read side of "HR can see everything about a staff member".
 *
 * Each of these answers a question HR could not previously ask at all, because
 * the data lived on the pipeline record and nothing tied that record to an
 * employee. They all degrade gracefully for a direct hire: an employee with no
 * `staffApplicantId` simply has no pipeline history and no field attendance,
 * and each response says so rather than looking like an error.
 */
/** Pipeline status -> the HR label for it, mirroring the projection's mapping. */
const PIPELINE_TO_HR_STATUS: Record<string, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HALF_DAY: 'Half Day',
  OVERTIME: 'Present',
};

@Injectable()
export class EmployeeProfileService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true, fullName: true, employeeId: true, staffApplicantId: true },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);
    return employee;
  }

  /** Everything that happened to this person while they were a candidate. */
  async pipelineHistory(employeeId: string) {
    const employee = await this.requireEmployee(employeeId);
    if (!employee.staffApplicantId) {
      return {
        linkedToPipeline: false,
        note: 'Direct HR hire — this employee never went through the S1-S5 pipeline.',
        applicant: null,
        events: [],
        total: 0,
      };
    }

    const [applicant, events] = await Promise.all([
      this.prisma.staffApplicant.findUnique({
        where: { id: employee.staffApplicantId },
        select: {
          id: true,
          staffCode: true,
          series: true,
          languageTier: true,
          pipelineStage: true,
          pvStatus: true,
          terminalOutcome: true,
          currentScenarioCode: true,
          restrictedListFlag: true,
          createdAt: true,
          branch: { select: { id: true, name: true } },
          assignedRm: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.pipelineEvent.findMany({
        where: { staffId: employee.staffApplicantId },
        orderBy: { occurredAt: 'desc' },
        take: 200,
        select: {
          id: true,
          eventType: true,
          fromStage: true,
          toStage: true,
          reasonCode: true,
          scenarioCode: true,
          notes: true,
          occurredAt: true,
          actorId: true,
        },
      }),
    ]);

    // Resolve actor names in one query rather than a join per event — the
    // events table is append-only and has no relation to users.
    const actorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, fullName: true, role: true },
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    return {
      linkedToPipeline: true,
      applicant,
      events: events.map((e) => ({
        ...e,
        actor: e.actorId ? (actorById.get(e.actorId) ?? null) : null,
      })),
      total: events.length,
    };
  }

  /** Incidents raised against this person during deployment. */
  async incidents(employeeId: string) {
    const employee = await this.requireEmployee(employeeId);
    if (!employee.staffApplicantId) {
      return { linkedToPipeline: false, items: [], total: 0, openCount: 0 };
    }

    const items = await this.prisma.incident.findMany({
      where: { staffId: employee.staffApplicantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        description: true,
        resolution: true,
        legalHold: true,
        resolvedAt: true,
        createdAt: true,
        comments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, body: true, createdAt: true, actorId: true },
        },
      },
    });

    return {
      linkedToPipeline: true,
      items,
      total: items.length,
      openCount: items.filter((i) => i.status === 'OPEN').length,
    };
  }

  /**
   * One month of attendance for one employee, merging the HR ledger with the
   * pipeline's own record so a discrepancy between the two is visible rather
   * than hidden behind whichever screen you happened to open.
   *
   * `source` on each day says who owns it:
   *  - HR    — an HR user marked or corrected it (attendance.marked_by set)
   *  - FIELD — projected from the staff member's own check-ins
   *  - PIPELINE_ONLY — present on the pipeline side but not yet projected
   *    across, which is what a stale sync looks like
   */
  async attendanceMonth(employeeId: string, month: number, year: number) {
    const employee = await this.requireEmployee(employeeId);
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0));

    // Typed explicitly: the ternary below yields a union with `never[]` for the
    // direct-hire branch, which otherwise widens the rows to `unknown`.
    type FieldRow = {
      id: string;
      attendanceDate: Date;
      status: string;
      overtimeHours: unknown;
      notes: string | null;
      placementId: string | null;
    };

    const [hrRows, fieldRows] = await Promise.all([
      this.prisma.employeeAttendance.findMany({
        where: { employeeId, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
        select: {
          id: true,
          date: true,
          status: true,
          checkIn: true,
          checkOut: true,
          workingHours: true,
          notes: true,
          markedBy: true,
        },
      }),
      employee.staffApplicantId
        ? this.prisma.staffDailyAttendance.findMany({
            where: {
              staffId: employee.staffApplicantId,
              attendanceDate: { gte: from, lte: to },
            },
            orderBy: { attendanceDate: 'asc' },
            select: {
              id: true,
              attendanceDate: true,
              status: true,
              overtimeHours: true,
              notes: true,
              placementId: true,
            },
          })
        : Promise.resolve([] as FieldRow[]),
    ]);

    const key = (d: Date) => d.toISOString().slice(0, 10);
    const fieldByDate = new Map<string, FieldRow>(
      (fieldRows as FieldRow[]).map((r) => [key(r.attendanceDate), r] as [string, FieldRow]),
    );
    const days = new Map<string, any>();

    for (const r of hrRows) {
      const day = key(r.date);
      const field = fieldByDate.get(day);
      days.set(day, {
        date: day,
        status: r.status,
        effectiveStatus: r.status,
        source: r.markedBy ? 'HR' : 'FIELD',
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        workingHours: r.workingHours,
        notes: r.notes,
        pipelineStatus: field?.status ?? null,
        // A day HR corrected legitimately differs from the field record; this
        // flag is what makes that visible instead of surprising.
        divergesFromField: Boolean(field && !this.statusesAgree(r.status, field.status)),
      });
    }

    for (const [day, r] of fieldByDate) {
      if (days.has(day)) continue;
      days.set(day, {
        date: day,
        status: null,
        // The day is real and the staff member is marked for it — the HR ledger
        // simply has not been projected yet. Callers should show this rather
        // than a blank, so a check-in from ten minutes ago is not invisible.
        effectiveStatus: PIPELINE_TO_HR_STATUS[r.status] ?? r.status,
        source: 'PIPELINE_ONLY',
        checkIn: null,
        checkOut: null,
        workingHours: null,
        notes: r.notes,
        pipelineStatus: r.status,
        divergesFromField: false,
      });
    }

    const items = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Counted on effectiveStatus so a day that has not been projected yet still
    // counts towards Present, matching what the screen shows.
    const counts = items.reduce<Record<string, number>>((acc, d) => {
      const label = d.effectiveStatus ?? 'Unknown';
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});

    return {
      employeeId,
      month,
      year,
      linkedToPipeline: Boolean(employee.staffApplicantId),
      items,
      total: items.length,
      counts,
      unprojectedDays: items.filter((d) => d.source === 'PIPELINE_ONLY').length,
      divergingDays: items.filter((d) => d.divergesFromField).length,
    };
  }

  /** Maps the two status vocabularies onto each other for the divergence check. */
  private statusesAgree(hrStatus: string, pipelineStatus: string): boolean {
    const map: Record<string, string[]> = {
      PRESENT: ['Present', 'Late'],
      ABSENT: ['Absent'],
      LEAVE: ['Leave'],
      HALF_DAY: ['Half Day'],
      OVERTIME: ['Present', 'Late'],
    };
    return (map[pipelineStatus] ?? []).includes(hrStatus);
  }
}
