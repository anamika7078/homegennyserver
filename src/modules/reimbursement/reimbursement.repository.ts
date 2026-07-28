import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ReimbursementStatus } from '@prisma/client';
import { CreateReimbursementDto, UpdateReimbursementStatusDto } from './dto/reimbursement.dto';

@Injectable()
export class ReimbursementRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateReimbursementDto) {
    return this.prisma.reimbursementRequest.create({
      data: {
        ...dto,
        expenseDate: new Date(dto.expenseDate),
      },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findAll(params: { employeeId?: string; status?: string; category?: string; month?: number; year?: number }) {
    const where: Prisma.ReimbursementRequestWhereInput = {};
    if (params.employeeId) where.employeeId = params.employeeId;
    if (params.status) where.status = params.status as ReimbursementStatus;
    if (params.category) where.category = params.category;
    if (params.month && params.year) {
      const start = new Date(params.year, params.month - 1, 1);
      const end = new Date(params.year, params.month, 0, 23, 59, 59);
      where.expenseDate = { gte: start, lte: end };
    }

    return this.prisma.reimbursementRequest.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findById(id: string) {
    return this.prisma.reimbursementRequest.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async updateStatus(id: string, dto: UpdateReimbursementStatusDto) {
    const data: any = {
      status: dto.status,
      rejectionReason: dto.rejectionReason,
    };
    if (dto.status === ReimbursementStatus.APPROVED || dto.approvalRole) {
      if (dto.approvalRole === 'manager') data.managerApproval = true;
      if (dto.approvalRole === 'finance') data.financeApproval = true;
      if (dto.approvalRole === 'payroll') data.payrollApproval = true;
    }
    return this.prisma.reimbursementRequest.update({
      where: { id },
      data,
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async delete(id: string) {
    return this.prisma.reimbursementRequest.delete({ where: { id } });
  }
}
