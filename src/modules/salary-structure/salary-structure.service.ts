import { Injectable, BadRequestException } from '@nestjs/common';
import { SalaryStructureRepository } from './salary-structure.repository';
import { CreateSalaryStructureDto, UpdateSalaryStructureDto } from './dto/salary-structure.dto';
import { SalaryComponentType, CalculationType } from '@prisma/client';

@Injectable()
export class SalaryStructureService {
  constructor(private readonly repository: SalaryStructureRepository) {}

  async create(dto: CreateSalaryStructureDto) {
    if (dto.basicSalary <= 0) {
      throw new BadRequestException('Basic salary must be greater than zero.');
    }
    return this.repository.create(dto);
  }

  async findAll(query: any) {
    return this.repository.findAll(query);
  }

  async findById(id: string) {
    return this.repository.findById(id);
  }

  async update(id: string, dto: UpdateSalaryStructureDto) {
    if (dto.basicSalary !== undefined && dto.basicSalary <= 0) {
      throw new BadRequestException('Basic salary must be greater than zero.');
    }
    return this.repository.update(id, dto);
  }

  async delete(id: string) {
    return this.repository.delete(id);
  }

  async clone(id: string, newTemplateName?: string) {
    return this.repository.clone(id, newTemplateName);
  }

  /**
   * Simulate calculation of components and net earnings for a template given a basic salary or working days.
   */
  async simulateCalculation(id: string, customBasic?: number, workingDays = 30, presentDays = 30) {
    const structure = await this.findById(id);
    const basic = customBasic ? Number(customBasic) : Number(structure.basicSalary);
    const prorationRatio = workingDays > 0 ? presentDays / workingDays : 1;

    let totalEarnings = basic * prorationRatio;
    let totalDeductions = 0;
    const simulatedComponents: any[] = [];

    for (const comp of structure.components) {
      let calcAmount = Number(comp.amount);
      if (comp.calculationType === CalculationType.PERCENTAGE && comp.percentageValue) {
        calcAmount = (basic * Number(comp.percentageValue)) / 100;
      }
      if (comp.calculationType === CalculationType.ATTENDANCE_BASED) {
        calcAmount = calcAmount * prorationRatio;
      }

      simulatedComponents.push({
        id: comp.id,
        name: comp.name,
        type: comp.type,
        calculationType: comp.calculationType,
        baseAmount: Number(comp.amount),
        percentageValue: comp.percentageValue ? Number(comp.percentageValue) : null,
        calculatedAmount: Math.round(calcAmount * 100) / 100,
      });

      if (comp.type === SalaryComponentType.EARNING) {
        totalEarnings += calcAmount;
      } else if (comp.type === SalaryComponentType.DEDUCTION || comp.type === SalaryComponentType.STATUTORY) {
        totalDeductions += calcAmount;
      }
    }

    const netSalary = totalEarnings - totalDeductions;

    return {
      templateId: structure.id,
      templateName: structure.templateName,
      basicSalary: basic,
      workingDays,
      presentDays,
      prorationRatio: Math.round(prorationRatio * 100) / 100,
      simulatedComponents,
      summary: {
        basic: Math.round(basic * prorationRatio * 100) / 100,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        netSalary: Math.round(netSalary * 100) / 100,
      },
    };
  }
}
