import { Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceRepository } from './attendance.repository';
import { StaffAttendanceMirrorService } from './staff-attendance-mirror.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Parse YYYY-MM-DD as a UTC calendar date.
 *
 * This used to build a LOCAL midnight Date. `attendance.date` is a Postgres
 * DATE column and Prisma serialises a JS Date to it by UTC calendar day, so on
 * an IST (UTC+5:30) server every HR-marked day was stored as the day BEFORE the
 * one HR picked — verified against this database: new Date(2031, 0, 15) landed
 * as 2031-01-14. It also has to agree with staff_daily_attendance, which the
 * mobile check-in and RM both write at UTC midnight.
 */
function parseDateOnly(dateStr: string): Date {
  return StaffAttendanceMirrorService.toUtcDateOnly(dateStr);
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly repo: AttendanceRepository,
    private readonly mirror: StaffAttendanceMirrorService,
    private readonly prisma: PrismaService,
  ) {}

  async findAll(params: any) {
    return this.repo.findAll(params);
  }

  /**
   * The day's marking list — one row per place a staff member works.
   *
   * HR's screen used to list employees, one row each, and mark "Present" with
   * nothing to say where. That worked while everyone held exactly one
   * placement. A maid doing three houses needs three rows, because the day
   * belongs to a client: it decides whose invoice carries it, and for an
   * hourly placement how many hours were worked decides what it costs.
   *
   * Employees with no active placement (office hires) are not here — there is
   * nothing to bill and no client to name. They stay on HR's own ledger.
   */
  async roster(date: string, branchId?: string) {
    const attendanceDate = parseDateOnly(date);

    const placements = await this.prisma.placement.findMany({
      where: {
        status: { in: ['CONFIRMED', 'TRIAL'] },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        id: true, staffId: true, clientId: true, status: true,
        placementType: true, shiftHours: true, hourlyRate: true,
      },
    });
    if (!placements.length) return { date, rows: [] };

    const staffIds = [...new Set(placements.map((p) => p.staffId))];
    const clientIds = [...new Set(placements.map((p) => p.clientId))];

    const [staff, clients, employees, marked] = await Promise.all([
      this.prisma.staffApplicant.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true, staffCode: true, series: true },
      }),
      this.prisma.financeCustomer.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, customerName: true, unitCode: true },
      }),
      // The HR-side id, which is what POST /attendance/mark takes.
      this.prisma.employee.findMany({
        where: { staffApplicantId: { in: staffIds }, deletedAt: null },
        select: { id: true, staffApplicantId: true },
      }),
      this.prisma.staffDailyAttendance.findMany({
        where: { placementId: { in: placements.map((p) => p.id) }, attendanceDate },
        select: { placementId: true, status: true, hoursWorked: true, notes: true },
      }),
    ]);

    const staffMap    = new Map(staff.map((s) => [s.id, s]));
    const clientMap   = new Map(clients.map((c) => [c.id, c]));
    const employeeMap = new Map(employees.map((e) => [e.staffApplicantId as string, e.id]));
    const markedMap   = new Map(marked.map((m) => [m.placementId as string, m]));

    const rows = placements
      .map((p) => {
        const s = staffMap.get(p.staffId);
        const c = clientMap.get(p.clientId);
        const m = markedMap.get(p.id);
        return {
          placement_id: p.id,
          placement_type: p.placementType ?? 'PERMANENT',
          placement_status: p.status,
          shift_hours: p.shiftHours != null ? Number(p.shiftHours) : null,
          hourly_rate: p.hourlyRate != null ? Number(p.hourlyRate) : null,
          staff_id: p.staffId,
          staff_name: s?.fullName ?? null,
          staff_code: s?.staffCode ?? null,
          series: s?.series ?? null,
          client_id: p.clientId,
          client_name: c?.customerName ?? null,
          unit_code: c?.unitCode ?? null,
          // Null for a staff member never onboarded into HR — the row is shown
          // so the gap is visible rather than the person silently missing.
          employee_id: employeeMap.get(p.staffId) ?? null,
          marked_status: m?.status ?? null,
          marked_hours: m?.hoursWorked != null ? Number(m.hoursWorked) : null,
          notes: m?.notes ?? null,
        };
      })
      .sort((a, b) =>
        (a.staff_name ?? '').localeCompare(b.staff_name ?? '') ||
        (a.client_name ?? '').localeCompare(b.client_name ?? ''),
      );

    return { date, rows };
  }

  async findOne(id: string) {
    const log = await this.repo.findById(id);
    if (!log) {
      throw new NotFoundException(`Attendance record with ID ${id} not found`);
    }
    return log;
  }

  calculateWorkingHours(checkIn?: string | Date | null, checkOut?: string | Date | null): number | null {
    if (!checkIn || !checkOut) return null;
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const diffMs = end.getTime() - start.getTime();
    if (diffMs > 0) {
      const hours = diffMs / (1000 * 60 * 60);
      return Number(hours.toFixed(2));
    }
    return 0;
  }

  async mark(dto: any, actorId: string) {
    const employee = await this.repo.findEmployeeById(dto.employeeId);
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${dto.employeeId} not found`);
    }

    const attendanceDate = parseDateOnly(dto.date);

    // Mirror FIRST. For a pipeline-onboarded employee this is the write that
    // actually counts — staff_daily_attendance is what payroll and client
    // invoicing read, while `attendance` is only HR's own ledger. It also
    // rejects the case where the staff member has their own live GPS check-in
    // for the day, and that rejection has to stop the whole operation rather
    // than leave the two tables disagreeing.
    const mirrored = await this.mirror.mirror({
      employeeId: dto.employeeId,
      date: dto.date,
      status: dto.status,
      actorId,
      notes: dto.notes,
      overtimeHours: dto.overtimeHours,
      // Which client's day this was, and how long it ran. Both matter once a
      // staff member works more than one house: the placement decides whose
      // invoice carries the day, the hours decide what an hourly one costs.
      placementId: dto.placementId ?? null,
      hoursWorked: dto.hoursWorked != null ? Number(dto.hoursWorked) : undefined,
      overrideSelfCheckIn: dto.overrideSelfCheckIn === true,
    });

    // Upsert: update if already marked for this employee + date
    const existing = await this.repo.findByEmployeeIdAndDate(dto.employeeId, attendanceDate);
    if (existing) {
      const updated = await this.edit(existing.id, {
        status: dto.status,
        checkIn: dto.checkIn,
        checkOut: dto.checkOut,
        notes: dto.notes,
        // Re-stamp the actor even though the row already exists. The row may
        // have been written by PipelineAttendanceProjectionService, which
        // leaves marked_by NULL to mark a row as system-owned and therefore
        // safe to overwrite on the next run. A human correcting the day has to
        // take ownership of it here, or the next projection would quietly undo
        // the correction.
        markedBy: actorId,
      });
      return { ...updated, pipelineAttendance: mirrored };
    }

    const workingHours = this.calculateWorkingHours(dto.checkIn, dto.checkOut);

    const createData: Prisma.EmployeeAttendanceCreateInput = {
      date: attendanceDate,
      checkIn: dto.checkIn ? new Date(dto.checkIn) : null,
      checkOut: dto.checkOut ? new Date(dto.checkOut) : null,
      workingHours: workingHours !== null ? new Prisma.Decimal(workingHours) : null,
      status: dto.status,
      notes: dto.notes || null,
      markedBy: actorId,
      employee: { connect: { id: dto.employeeId } },
    };

    const created = await this.repo.create(createData);
    return { ...created, pipelineAttendance: mirrored };
  }

  /**
   * Edits one HR attendance row. When the status changes on a
   * pipeline-onboarded employee the mirrored day has to move with it, or
   * payroll keeps counting the status HR just corrected away from.
   */
  async editAndMirror(id: string, dto: any, actorId: string) {
    const existing = await this.findOne(id);
    let mirrored: Awaited<ReturnType<StaffAttendanceMirrorService['mirror']>> = null;
    if (dto.status && dto.status !== existing.status) {
      mirrored = await this.mirror.mirror({
        employeeId: existing.employeeId,
        date: existing.date,
        status: dto.status,
        actorId,
        notes: dto.notes ?? existing.notes,
        overtimeHours: dto.overtimeHours,
        overrideSelfCheckIn: dto.overrideSelfCheckIn === true,
      });
    }
    // Same ownership transfer as mark() — an HR edit makes the day HR's.
    const updated = await this.edit(id, { ...dto, markedBy: actorId });
    return { ...updated, pipelineAttendance: mirrored };
  }

  async edit(id: string, dto: any) {
    const existing = await this.findOne(id);

    const checkIn = dto.checkIn !== undefined ? (dto.checkIn ? new Date(dto.checkIn) : null) : existing.checkIn;
    const checkOut = dto.checkOut !== undefined ? (dto.checkOut ? new Date(dto.checkOut) : null) : existing.checkOut;
    const workingHours = this.calculateWorkingHours(checkIn, checkOut);

    const updateData: Prisma.EmployeeAttendanceUpdateInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.checkIn !== undefined ? { checkIn } : {}),
      ...(dto.checkOut !== undefined ? { checkOut } : {}),
      workingHours: workingHours !== null ? new Prisma.Decimal(workingHours) : null,
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.markedBy ? { markedBy: dto.markedBy } : {}),
    };

    return this.repo.update(id, updateData);
  }

  async approve(ids: string[], actorId: string) {
    return this.repo.updateManyStatus(ids, actorId);
  }

  async getStats(dateStr?: string, branchId?: string) {
    const date = dateStr ? parseDateOnly(dateStr) : new Date();
    return this.repo.getAttendanceStatsForDate(date, branchId);
  }
}
