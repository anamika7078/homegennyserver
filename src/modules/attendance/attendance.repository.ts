import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmployeeIdAndDate(employeeId: string, date: Date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

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
    page?: number;
    limit?: number;
  }) {
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 50);
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeAttendanceWhereInput = {};

    if (params.date) {
      const d = new Date(params.date);
      const start = new Date(d.setHours(0, 0, 0, 0));
      const end = new Date(d.setHours(23, 59, 59, 999));
      where.date = { gte: start, lte: end };
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
        skip,
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
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const where: Prisma.EmployeeAttendanceWhereInput = {
      date: { gte: start, lte: end },
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
