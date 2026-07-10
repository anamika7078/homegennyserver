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

  async findExistingIdsStartingWith(prefix: string) {
    // Find all active/inactive employee IDs that start with the prefix
    const employees = await this.prisma.employee.findMany({
      where: {
        employeeId: {
          startsWith: prefix,
          mode: 'insensitive',
        },
      },
      select: { employeeId: true },
    });
    return employees.map((e) => e.employeeId);
  }

  async create(data: Prisma.EmployeeCreateInput) {
    return this.prisma.employee.create({
      data,
      include: {
        category: true,
        branch: true,
      },
    });
  }

  async update(id: string, data: Prisma.EmployeeUpdateInput) {
    return this.prisma.employee.update({
      where: { id },
      data,
      include: {
        category: true,
        branch: true,
      },
    });
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
}
