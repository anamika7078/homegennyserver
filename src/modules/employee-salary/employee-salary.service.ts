import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { EmployeeSalaryRepository } from './employee-salary.repository';
import { AssignSalaryProfileDto, CreateSalaryRevisionDto } from './dto/employee-salary.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EmployeeSalaryService {
  constructor(
    private readonly repository: EmployeeSalaryRepository,
    private readonly prisma: PrismaService,
  ) {}

  async assignProfile(dto: AssignSalaryProfileDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${dto.employeeId} not found.`);
    }
    if (dto.templateId) {
      const template = await this.prisma.salaryStructure.findUnique({
        where: { id: dto.templateId },
      });
      if (!template) {
        throw new NotFoundException(`Salary Structure template with ID ${dto.templateId} not found.`);
      }
    }
    if (dto.grossSalary < 0) {
      throw new BadRequestException('Gross salary cannot be negative.');
    }
    return this.repository.assignProfile(dto);
  }

  async findByEmployeeId(employeeId: string) {
    const res = await this.repository.findByEmployeeId(employeeId);
    if (!res.profile) {
      // Return empty profile shell if not yet assigned
      const employee = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, employeeId: true, fullName: true, department: true, designation: true },
      });
      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found.`);
      }
      return {
        profile: null,
        employee,
        revisions: [],
      };
    }
    return res;
  }

  async findAll(query: any) {
    return this.repository.findAll(query);
  }

  async reviseSalary(employeeId: string, dto: CreateSalaryRevisionDto) {
    if (dto.newGross <= 0) {
      throw new BadRequestException('New gross salary must be greater than zero.');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found.`);
    }
    return this.repository.addRevision(employeeId, dto);
  }
}
