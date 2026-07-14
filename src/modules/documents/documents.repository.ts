import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class DocumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmployeeId(employeeId: string) {
    return this.prisma.employeeDocument.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findEmployeeById(id: string) {
    return this.prisma.employee.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
  }

  async findById(id: string) {
    return this.prisma.employeeDocument.findUnique({
      where: { id },
      include: { employee: true },
    });
  }

  async findByEmployeeAndType(employeeId: string, type: string) {
    return this.prisma.employeeDocument.findFirst({
      where: { employeeId, type },
    });
  }

  async create(data: Prisma.EmployeeDocumentCreateInput) {
    return this.prisma.employeeDocument.create({
      data,
    });
  }

  async update(id: string, data: Prisma.EmployeeDocumentUpdateInput) {
    return this.prisma.employeeDocument.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.employeeDocument.delete({
      where: { id },
    });
  }

  async findExpiringDocuments(type: string, daysThreshold: number) {
    const today = new Date();
    const thresholdDate = new Date();
    thresholdDate.setDate(today.getDate() + daysThreshold);

    return this.prisma.employeeDocument.findMany({
      where: {
        type,
        validTill: {
          not: null,
          lte: thresholdDate,
          gt: today,
        },
        status: {
          not: 'Expired',
        },
      },
      include: { employee: true },
    });
  }

  async findExpiredDocuments(type: string) {
    const today = new Date();

    return this.prisma.employeeDocument.findMany({
      where: {
        type,
        validTill: {
          not: null,
          lt: today,
        },
        status: {
          not: 'Expired',
        },
      },
      include: { employee: true },
    });
  }
}
