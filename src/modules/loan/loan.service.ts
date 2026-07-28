import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { LoanRepository } from './loan.repository';
import { CreateEmployeeLoanDto, CreateSalaryAdvanceDto, UpdateLoanStatusDto } from './dto/loan.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LoanService {
  constructor(
    private readonly repository: LoanRepository,
    private readonly prisma: PrismaService,
  ) {}

  async createLoan(dto: CreateEmployeeLoanDto) {
    if (dto.loanAmount <= 0 || dto.monthlyEmi <= 0) {
      throw new BadRequestException('Loan amount and EMI must be greater than zero.');
    }
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw new NotFoundException(`Employee ${dto.employeeId} not found.`);
    return this.repository.createLoan(dto);
  }

  async findAllLoans(query: any) {
    return this.repository.findAllLoans({
      employeeId: query.employeeId,
      status: query.status,
    });
  }

  async findLoanById(id: string) {
    const loan = await this.repository.findLoanById(id);
    if (!loan) throw new NotFoundException(`Loan ${id} not found.`);
    return loan;
  }

  async updateLoanStatus(id: string, dto: UpdateLoanStatusDto) {
    await this.findLoanById(id);
    return this.repository.updateLoanStatus(id, dto.status);
  }

  async deleteLoan(id: string) {
    await this.findLoanById(id);
    return this.repository.deleteLoan(id);
  }

  async createAdvance(dto: CreateSalaryAdvanceDto) {
    if (dto.amount <= 0) {
      throw new BadRequestException('Advance amount must be greater than zero.');
    }
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
    if (!emp) throw new NotFoundException(`Employee ${dto.employeeId} not found.`);
    return this.repository.createAdvance(dto);
  }

  async findAllAdvances(query: any) {
    return this.repository.findAllAdvances({
      employeeId: query.employeeId,
      status: query.status,
      month: query.month ? Number(query.month) : undefined,
      year: query.year ? Number(query.year) : undefined,
    });
  }

  async updateAdvanceStatus(id: string, dto: UpdateLoanStatusDto) {
    return this.repository.updateAdvanceStatus(id, dto.status);
  }

  async deleteAdvance(id: string) {
    return this.repository.deleteAdvance(id);
  }
}
