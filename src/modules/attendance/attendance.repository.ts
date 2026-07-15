import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  private dayRange(date: Date) {
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return { startOfDay, endOfDay };
  }

  private parseDateOnly(dateStr: string): Date {
    const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
    if (!y || !m || !d) return new Date(dateStr);
    return new Date(y, m - 1, d);
  }

  async findByEmployeeIdAndDate(employeeId: string, date: Date) {
    const { startOfDay, endOfDay } = this.dayRange(date);

    return this.prisma.employeeAttendance.findFirst({
      where: {
        employeeId,
        date: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });
  }

  async findEmployeeById(id: string) {
    return this.prisma.employee.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
  }

  async findById(id: string) {
    return this.prisma.employeeAttendance.findUnique({
      where: { id },
      include: { employee: true },
    });
  }

  async findAll(params: {
    date?: string;
    employeeId?: string;
    branchId?: string;
    categoryId?: string;
    page?: number | string;
    limit?: number | string;
  }) {
    const page = Math.max(1, parseInt(String(params.page ?? 1), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(String(params.limit ?? 50), 10) || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeAttendanceWhereInput = {};

    if (params.date) {
      const d = this.parseDateOnly(params.date);
      const { startOfDay, endOfDay } = this.dayRange(d);
      where.date = { gte: startOfDay, lte: endOfDay };
    }

    if (params.employeeId) {
      where.employeeId = params.employeeId;
    }

    if (params.branchId || params.categoryId) {
      where.employee = {
        deletedAt: null,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      };
    } else {
      where.employee = { deletedAt: null };
    }

    const [items, total] = await Promise.all([
      this.prisma.employeeAttendance.findMany({
        where,
        skip: skip,
        take: limit,
        orderBy: { date: 'desc' },
        include: {
          employee: {
            include: {
              category: true,
              branch: true,
            },
          },
        },
      }),
      this.prisma.employeeAttendance.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async create(data: Prisma.EmployeeAttendanceCreateInput) {
    return this.prisma.employeeAttendance.create({
      data,
      include: { employee: true },
    });
  }

  async update(id: string, data: Prisma.EmployeeAttendanceUpdateInput) {
    return this.prisma.employeeAttendance.update({
      where: { id },
      data,
      include: { employee: true },
    });
  }

  async updateManyStatus(ids: string[], approvedBy: string) {
    return this.prisma.employeeAttendance.updateMany({
      where: { id: { in: ids } },
      data: { approvedBy },
    });
  }

  async getAttendanceStatsForDate(date: Date, branchId?: string) {
    const { startOfDay, endOfDay } = this.dayRange(date);

    const where: Prisma.EmployeeAttendanceWhereInput = {
      date: { gte: startOfDay, lte: endOfDay },
    };

    if (branchId) {
      where.employee = { branchId, deletedAt: null };
    } else {
      where.employee = { deletedAt: null };
    }

    const logs = await this.prisma.employeeAttendance.findMany({
      where,
      select: { status: true },
    });

    const stats = {
      Present: 0,
      Absent: 0,
      Leave: 0,
      HalfDay: 0,
      Late: 0,
    };

    for (const log of logs) {
      if (log.status === 'Present') stats.Present++;
      else if (log.status === 'Absent') stats.Absent++;
      else if (log.status === 'Leave') stats.Leave++;
      else if (log.status === 'Half Day') stats.HalfDay++;
      else if (log.status === 'Late') stats.Late++;
    }

    return stats;
  }
}
