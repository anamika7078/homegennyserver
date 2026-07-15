import { Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceRepository } from './attendance.repository';
import { Prisma } from '@prisma/client';

/** Parse YYYY-MM-DD as a local calendar date (avoids UTC offset shift). */
function parseDateOnly(dateStr: string): Date {
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return new Date(dateStr);
  return new Date(y, m - 1, d);
}

@Injectable()
export class AttendanceService {
  constructor(private readonly repo: AttendanceRepository) {}

  async findAll(params: any) {
    return this.repo.findAll(params);
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

    // Upsert: update if already marked for this employee + date
    const existing = await this.repo.findByEmployeeIdAndDate(dto.employeeId, attendanceDate);
    if (existing) {
      return this.edit(existing.id, {
        status: dto.status,
        checkIn: dto.checkIn,
        checkOut: dto.checkOut,
        notes: dto.notes,
      });
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

    return this.repo.create(createData);
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
