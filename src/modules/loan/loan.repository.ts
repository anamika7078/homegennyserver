import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, LoanStatus } from '@prisma/client';
import { CreateEmployeeLoanDto, CreateSalaryAdvanceDto, UpdateLoanStatusDto } from './dto/loan.dto';

@Injectable()
export class LoanRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Employee Loan CRUD
  async createLoan(dto: CreateEmployeeLoanDto) {
    return this.prisma.employeeLoan.create({
      data: {
        ...dto,
        remainingAmount: dto.loanAmount,
        startDate: new Date(dto.startDate),
      },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findAllLoans(params: { employeeId?: string; status?: string }) {
    const where: Prisma.EmployeeLoanWhereInput = {};
    if (params.employeeId) where.employeeId = params.employeeId;
    if (params.status) where.status = params.status as LoanStatus;

    return this.prisma.employeeLoan.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findLoanById(id: string) {
    return this.prisma.employeeLoan.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async updateLoanStatus(id: string, status: LoanStatus) {
    return this.prisma.employeeLoan.update({
      where: { id },
      data: { status },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async deleteLoan(id: string) {
    return this.prisma.employeeLoan.delete({ where: { id } });
  }

  // Salary Advance CRUD
  async createAdvance(dto: CreateSalaryAdvanceDto) {
    return this.prisma.salaryAdvance.create({
      data: {
        ...dto,
        remainingAmount: dto.amount,
      },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async findAllAdvances(params: { employeeId?: string; status?: string; month?: number; year?: number }) {
    const where: Prisma.SalaryAdvanceWhereInput = {};
    if (params.employeeId) where.employeeId = params.employeeId;
    if (params.status) where.status = params.status as LoanStatus;
    if (params.month) where.recoveryMonth = Number(params.month);
    if (params.year) where.recoveryYear = Number(params.year);

    return this.prisma.salaryAdvance.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async updateAdvanceStatus(id: string, status: LoanStatus) {
    return this.prisma.salaryAdvance.update({
      where: { id },
      data: { status },
      include: {
        employee: { select: { id: true, employeeId: true, fullName: true, department: true } },
      },
    });
  }

  async deleteAdvance(id: string) {
    return this.prisma.salaryAdvance.delete({ where: { id } });
  }
}
