import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { AssignSalaryProfileDto, CreateSalaryRevisionDto } from './dto/employee-salary.dto';

@Injectable()
export class EmployeeSalaryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async assignProfile(dto: AssignSalaryProfileDto) {
    const { employeeId, templateId, panNumber, pfUan, pan, uan, ...rest } = dto as any;
    const cleanTemplateId = templateId && typeof templateId === 'string' && templateId.trim() !== '' ? templateId : null;
    const finalPan = pan !== undefined ? pan : (panNumber !== undefined ? panNumber : undefined);
    const finalUan = uan !== undefined ? uan : (pfUan !== undefined ? pfUan : undefined);
    const dataObj = {
      ...rest,
      ...(finalPan !== undefined ? { pan: finalPan } : {}),
      ...(finalUan !== undefined ? { uan: finalUan } : {}),
    };
    return this.prisma.employeeSalaryProfile.upsert({
      where: { employeeId },
      create: {
        employeeId,
        templateId: cleanTemplateId,
        ...dataObj,
      },
      update: {
        templateId: cleanTemplateId,
        ...dataObj,
      },
      include: {
        template: {
          include: { components: true },
        },
        employee: {
          select: { id: true, employeeId: true, fullName: true, department: true, designation: true, branchId: true },
        },
      },
    });
  }

  async findByEmployeeId(employeeId: string) {
    const profile = await this.prisma.employeeSalaryProfile.findUnique({
      where: { employeeId },
      include: {
        template: {
          include: { components: true },
        },
        employee: {
          select: {
            id: true,
            employeeId: true,
            fullName: true,
            department: true,
            designation: true,
            joiningDate: true,
            branch: { select: { id: true, name: true, city: true } },
          },
        },
      },
    });

    const revisions = await this.prisma.salaryRevision.findMany({
      where: { employeeId },
      orderBy: { effectiveDate: 'desc' },
    });

    return {
      profile,
      revisions,
    };
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    search?: string;
    department?: string;
    branchId?: string;
    templateId?: string;
  }) {
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      ...(params.search && {
        OR: [
          { fullName: { contains: params.search, mode: 'insensitive' } },
          { employeeId: { contains: params.search, mode: 'insensitive' } },
        ],
      }),
      ...(params.department && { department: params.department }),
      ...(params.branchId && { branchId: params.branchId }),
      ...(params.templateId && { salaryProfile: { templateId: params.templateId } }),
    };

    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          salaryProfile: {
            include: {
              template: { select: { id: true, templateName: true } },
            },
          },
          branch: { select: { id: true, name: true } },
        },
      }),
      this.prisma.employee.count({ where }),
    ]);

    const data = employees.map((emp) => {
      if (emp.salaryProfile) {
        return {
          ...emp.salaryProfile,
          employee: {
            id: emp.id,
            employeeId: emp.employeeId,
            fullName: emp.fullName,
            department: emp.department,
            designation: emp.designation,
            branch: emp.branch,
          },
        };
      }
      return {
        id: null,
        employeeId: emp.id,
        grossSalary: emp.salary || 0,
        bankName: null,
        accountNumber: null,
        ifsc: null,
        pan: null,
        uan: null,
        templateId: null,
        template: null,
        employee: {
          id: emp.id,
          employeeId: emp.employeeId,
          fullName: emp.fullName,
          department: emp.department,
          designation: emp.designation,
          branch: emp.branch,
        },
      };
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async addRevision(employeeId: string, dto: CreateSalaryRevisionDto) {
    const profile = await this.prisma.employeeSalaryProfile.findUnique({
      where: { employeeId },
    });

    const previousGross = profile ? Number(profile.grossSalary) : 0;
    const newGross = Number(dto.newGross);
    const incrementAmount = dto.incrementAmount !== undefined ? Number(dto.incrementAmount) : newGross - previousGross;
    const incrementPercent =
      dto.incrementPercent !== undefined
        ? Number(dto.incrementPercent)
        : previousGross > 0
          ? ((newGross - previousGross) / previousGross) * 100
          : 0;

    return this.prisma.$transaction(async (tx) => {
      const revision = await tx.salaryRevision.create({
        data: {
          employeeId,
          previousGross,
          newGross,
          incrementAmount,
          incrementPercent: Math.round(incrementPercent * 100) / 100,
          revisionType: dto.revisionType ?? 'INCREMENT',
          effectiveDate: new Date(dto.effectiveDate),
          notes: dto.notes,
          approvedBy: dto.approvedBy,
        },
      });

      const updatedProfile = await tx.employeeSalaryProfile.upsert({
        where: { employeeId },
        create: {
          employeeId,
          grossSalary: newGross,
        },
        update: {
          grossSalary: newGross,
        },
      });

      return {
        revision,
        profile: updatedProfile,
      };
    });
  }
}
