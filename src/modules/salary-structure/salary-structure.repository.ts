import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, SalaryComponentType, CalculationType } from '@prisma/client';
import { CreateSalaryStructureDto, UpdateSalaryStructureDto } from './dto/salary-structure.dto';

@Injectable()
export class SalaryStructureRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSalaryStructureDto) {
    const { components, effectiveDate, description, ...rest } = dto as any;
    return this.prisma.salaryStructure.create({
      data: {
        ...rest,
        effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
        components: components
          ? {
              create: components.map((comp) => ({
                name: comp.name,
                type: comp.type ?? SalaryComponentType.EARNING,
                calculationType: comp.calculationType ?? CalculationType.FLAT,
                amount: comp.amount ?? 0,
                percentageValue: comp.percentageValue ?? null,
                isTaxable: comp.isTaxable ?? true,
                isMandatory: comp.isMandatory ?? false,
              })),
            }
          : undefined,
      },
      include: {
        components: true,
        branch: {
          select: { id: true, name: true, city: true },
        },
      },
    });
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    search?: string;
    department?: string;
    designation?: string;
    status?: string;
    branchId?: string;
  }) {
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: Prisma.SalaryStructureWhereInput = {};

    if (params.search) {
      where.OR = [
        { templateName: { contains: params.search, mode: 'insensitive' } },
        { department: { contains: params.search, mode: 'insensitive' } },
        { designation: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.department) {
      where.department = params.department;
    }
    if (params.designation) {
      where.designation = params.designation;
    }
    if (params.status) {
      where.status = params.status;
    }
    if (params.branchId) {
      where.branchId = params.branchId;
    }

    const [data, total] = await Promise.all([
      this.prisma.salaryStructure.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          components: true,
          branch: { select: { id: true, name: true } },
          _count: { select: { employeeProfiles: true } },
        },
      }),
      this.prisma.salaryStructure.count({ where }),
    ]);

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

  async findById(id: string) {
    const structure = await this.prisma.salaryStructure.findUnique({
      where: { id },
      include: {
        components: true,
        branch: { select: { id: true, name: true, city: true } },
        employeeProfiles: {
          include: {
            employee: {
              select: { id: true, employeeId: true, fullName: true, department: true, designation: true },
            },
          },
        },
      },
    });
    if (!structure) {
      throw new NotFoundException(`Salary Structure template with ID ${id} not found.`);
    }
    return structure;
  }

  async update(id: string, dto: UpdateSalaryStructureDto) {
    await this.findById(id); // verify existence

    const { components, effectiveDate, description, ...rest } = dto as any;

    return this.prisma.$transaction(async (tx) => {
      if (components) {
        await tx.salaryComponent.deleteMany({ where: { structureId: id } });
      }

      return tx.salaryStructure.update({
        where: { id },
        data: {
          ...rest,
          effectiveDate: effectiveDate ? new Date(effectiveDate) : undefined,
          components: components
            ? {
                create: components.map((comp) => ({
                  name: comp.name,
                  type: comp.type ?? SalaryComponentType.EARNING,
                  calculationType: comp.calculationType ?? CalculationType.FLAT,
                  amount: comp.amount ?? 0,
                  percentageValue: comp.percentageValue ?? null,
                  isTaxable: comp.isTaxable ?? true,
                  isMandatory: comp.isMandatory ?? false,
                })),
              }
            : undefined,
        },
        include: {
          components: true,
          branch: { select: { id: true, name: true } },
        },
      });
    });
  }

  async delete(id: string) {
    await this.findById(id);
    return this.prisma.salaryStructure.delete({
      where: { id },
    });
  }

  async clone(id: string, newTemplateName?: string) {
    const original = await this.findById(id);
    const { id: _, createdAt, updatedAt, components, employeeProfiles, branch, ...rest } = original;

    return this.prisma.salaryStructure.create({
      data: {
        ...rest,
        templateName: newTemplateName ?? `${original.templateName} (Copy)`,
        components: {
          create: components.map((c) => ({
            name: c.name,
            type: c.type,
            calculationType: c.calculationType,
            amount: c.amount,
            percentageValue: c.percentageValue,
            isTaxable: c.isTaxable,
            isMandatory: c.isMandatory,
          })),
        },
      },
      include: {
        components: true,
      },
    });
  }
}
