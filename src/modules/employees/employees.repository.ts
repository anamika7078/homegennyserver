import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EmployeesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params: {
    page?: number;
    limit?: number;
    search?: string;
    branchId?: string;
    categoryId?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeWhereInput = {
      deletedAt: null,
    };

    if (params.search) {
      where.OR = [
        { fullName: { contains: params.search, mode: 'insensitive' } },
        { employeeId: { contains: params.search, mode: 'insensitive' } },
        { mobile: { contains: params.search } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { department: { contains: params.search, mode: 'insensitive' } },
        { designation: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    if (params.branchId) {
      where.branchId = params.branchId;
    }

    if (params.categoryId) {
      where.categoryId = params.categoryId;
    }

    if (params.status) {
      where.status = params.status;
    }

    const sortBy = params.sortBy ?? 'createdAt';
    const sortOrder = params.sortOrder ?? 'desc';
    const orderBy: Prisma.EmployeeOrderByWithRelationInput = {
      [sortBy]: sortOrder,
    };

    const [items, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: true,
          branch: true,
        },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findById(id: string) {
    return this.prisma.employee.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: true,
        branch: true,
        documents: true,
      },
    });
  }

  async findByEmployeeId(employeeId: string) {
    return this.prisma.employee.findFirst({
      where: { employeeId, deletedAt: null },
    });
  }

  async findExistingIdsStartingWith(prefix: string, excludeId?: string) {
    // Find all employee IDs that start with the prefix (case-insensitive)
    // Exclude the employee being updated (if any) so they don't collide with themselves
    const employees = await this.prisma.employee.findMany({
      where: {
        employeeId: {
          startsWith: prefix,
          mode: 'insensitive',
        },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { employeeId: true },
    });
    return employees.map((e) => e.employeeId);
  }

  async syncStaffApplicant(emp: any) {
    try {
      const existing = await this.prisma.staffApplicant.findFirst({
        where: { OR: [{ mobile: emp.mobile }, { staffCode: emp.employeeId }] },
      });
      if (!existing) {
        const depStr = `${emp.department || ''} ${emp.designation || ''}`.toUpperCase();
        let series = 'DRIVER';
        if (depStr.includes('MAID') || depStr.includes('COOK') || depStr.includes('CLEAN')) series = 'MAID';
        else if (depStr.includes('SKILL') || depStr.includes('CARE') || depStr.includes('NURSE')) series = 'SKILLED_CARE';
        else if (depStr.includes('UNSKILL') || depStr.includes('HELP') || depStr.includes('BOY') || depStr.includes('GUARD')) series = 'UNSKILLED_CARE';
        else if (depStr.includes('DRIV')) series = 'DRIVER';

        await this.prisma.staffApplicant.create({
          data: {
            staffCode: emp.employeeId,
            fullName: emp.fullName,
            mobile: emp.mobile,
            dateOfBirth: emp.dateOfBirth ?? '1995-01-01',
            address: emp.address ?? 'Delhi',
            series: series as any,
            branchId: emp.branchId || null,
            pipelineStage: 'S1_INTAKE',
            languageTier: 'T1' as any,
            pvStatus: 'CLEAR',
          },
        });
      } else {
        await this.prisma.staffApplicant.update({
          where: { id: existing.id },
          data: {
            fullName: emp.fullName,
            mobile: emp.mobile,
            branchId: emp.branchId || null,
          },
        });
      }
    } catch (err) {
      // Non-blocking sync attempt
    }
  }

  async create(data: Prisma.EmployeeCreateInput) {
    const emp = await this.prisma.employee.create({
      data,
      include: {
        category: true,
        branch: true,
      },
    });
    await this.syncStaffApplicant(emp);
    return emp;
  }

  async update(id: string, data: Prisma.EmployeeUpdateInput) {
    const emp = await this.prisma.employee.update({
      where: { id },
      data,
      include: {
        category: true,
        branch: true,
      },
    });
    await this.syncStaffApplicant(emp);
    return emp;
  }

  async softDelete(id: string) {
    return this.prisma.employee.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'Inactive',
      },
    });
  }

  async getBranches() {
    return this.prisma.branch.findMany({
      orderBy: { name: 'asc' },
    });
  }
}
