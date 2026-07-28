import { Injectable, NotFoundException } from '@nestjs/common';
import { OvertimeRepository } from './overtime.repository';
import { CreateOvertimeRuleDto, UpdateOvertimeRuleDto, CreateOvertimeRecordDto } from './dto/overtime.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OvertimeService {
  constructor(
    private readonly repository: OvertimeRepository,
    private readonly prisma: PrismaService,
  ) {}

  async createRule(dto: CreateOvertimeRuleDto) {
    return this.repository.createRule(dto);
  }

  async findAllRules() {
    return this.repository.findAllRules();
  }

  async updateRule(id: string, dto: UpdateOvertimeRuleDto) {
    return this.repository.updateRule(id, dto);
  }

  async deleteRule(id: string) {
    return this.repository.deleteRule(id);
  }

  async createRecord(dto: CreateOvertimeRecordDto) {
    const employee = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!employee) throw new NotFoundException(`Employee ${dto.employeeId} not found.`);

    // Auto calculate amount if not provided using matching department rule or default rate
    if (dto.totalAmount === undefined) {
      const rule = await this.prisma.overtimeRule.findFirst({
        where: { OR: [{ department: employee.department }, { department: null }], isActive: true },
        orderBy: { department: 'desc' },
      });
      const hourlyRate = rule ? Number(rule.hourlyRate) : 100; // default fallback 100/hr
      let multi = dto.rateMultiplier ? Number(dto.rateMultiplier) : 1.0;
      if (dto.isWeekend && rule) multi = Number(rule.weekendRateMulti);
      if (dto.isHoliday && rule) multi = Number(rule.holidayRateMulti);

      dto.totalAmount = Math.round(Number(dto.hours) * hourlyRate * multi * 100) / 100;
      dto.rateMultiplier = multi;
    }

    return this.repository.createRecord(dto);
  }

  async findAllRecords(query: any) {
    return this.repository.findAllRecords({
      employeeId: query.employeeId,
      status: query.status,
      month: query.month ? Number(query.month) : undefined,
      year: query.year ? Number(query.year) : undefined,
    });
  }

  async approveRecord(id: string, role?: 'manager' | 'hr' | 'payroll') {
    return this.repository.updateRecordStatus(id, 'APPROVED', role ?? 'manager');
  }

  async rejectRecord(id: string) {
    return this.repository.updateRecordStatus(id, 'REJECTED');
  }

  async deleteRecord(id: string) {
    return this.repository.deleteRecord(id);
  }
}
