import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateOvertimeRuleDto, UpdateOvertimeRuleDto, CreateOvertimeRecordDto } from './dto/overtime.dto';

@Injectable()
export class OvertimeRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Rules CRUD
  async createRule(dto: CreateOvertimeRuleDto) {
    return this.prisma.overtimeRule.create({ data: dto });
  }

  async findAllRules() {
    return this.prisma.overtimeRule.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async updateRule(id: string, dto: UpdateOvertimeRuleDto) {
    return this.prisma.overtimeRule.update({ where: { id }, data: dto });
  }

  async deleteRule(id: string) {
    return this.prisma.overtimeRule.delete({ where: { id } });
  }

  // Records CRUD
  async createRecord(dto: CreateOvertimeRecordDto) {
    return this.prisma.overtimeRecord.create({
      data: {
        ...dto,
        date: new Date(dto.date),
        totalAmount: dto.totalAmount ?? 0,
      },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findAllRecords(params: { employeeId?: string; status?: string; month?: number; year?: number }) {
    const where: Prisma.OvertimeRecordWhereInput = {};
    if (params.employeeId) where.employeeId = params.employeeId;
    if (params.status) where.status = params.status;
    if (params.month && params.year) {
      const start = new Date(params.year, params.month - 1, 1);
      const end = new Date(params.year, params.month, 0, 23, 59, 59);
      where.date = { gte: start, lte: end };
    }

    return this.prisma.overtimeRecord.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async updateRecordStatus(id: string, status: string, approvalRole?: 'manager' | 'hr' | 'payroll') {
    const data: any = { status };
    if (status === 'APPROVED') {
      if (approvalRole === 'manager') data.managerApproval = true;
      if (approvalRole === 'hr') data.hrApproval = true;
      if (approvalRole === 'payroll') data.payrollApproval = true;
    }
    return this.prisma.overtimeRecord.update({
      where: { id },
      data,
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async deleteRecord(id: string) {
    return this.prisma.overtimeRecord.delete({ where: { id } });
  }
}
