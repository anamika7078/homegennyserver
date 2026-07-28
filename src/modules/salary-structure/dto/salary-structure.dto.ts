import { IsString, IsNumber, IsOptional, IsArray, ValidateNested, IsBoolean, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { SalaryComponentType, CalculationType } from '@prisma/client';

export class CreateSalaryComponentDto {
  @IsString()
  name: string;

  @IsEnum(SalaryComponentType)
  @IsOptional()
  type?: SalaryComponentType;

  @IsEnum(CalculationType)
  @IsOptional()
  calculationType?: CalculationType;

  @IsNumber()
  @IsOptional()
  amount?: number;

  @IsNumber()
  @IsOptional()
  percentageValue?: number;

  @IsBoolean()
  @IsOptional()
  isTaxable?: boolean;

  @IsBoolean()
  @IsOptional()
  isMandatory?: boolean;

  @IsBoolean()
  @IsOptional()
  isStatutory?: boolean;
}

export class CreateSalaryStructureDto {
  @IsString()
  templateName: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  department: string;

  @IsString()
  designation: string;

  @IsString()
  employmentType: string;

  @IsNumber()
  basicSalary: number;

  @IsNumber()
  @IsOptional()
  hra?: number;

  @IsNumber()
  @IsOptional()
  specialAllowance?: number;

  @IsNumber()
  @IsOptional()
  medical?: number;

  @IsNumber()
  @IsOptional()
  travel?: number;

  @IsNumber()
  @IsOptional()
  internet?: number;

  @IsNumber()
  @IsOptional()
  foodAllowance?: number;

  @IsNumber()
  @IsOptional()
  bonus?: number;

  @IsNumber()
  @IsOptional()
  professionalTax?: number;

  @IsNumber()
  @IsOptional()
  pf?: number;

  @IsNumber()
  @IsOptional()
  esic?: number;

  @IsNumber()
  @IsOptional()
  tds?: number;

  @IsString()
  @IsOptional()
  effectiveDate?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  branchId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalaryComponentDto)
  @IsOptional()
  components?: CreateSalaryComponentDto[];
}

export class UpdateSalaryStructureDto {
  @IsString()
  @IsOptional()
  templateName?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  department?: string;

  @IsString()
  @IsOptional()
  designation?: string;

  @IsString()
  @IsOptional()
  employmentType?: string;

  @IsNumber()
  @IsOptional()
  basicSalary?: number;

  @IsNumber()
  @IsOptional()
  hra?: number;

  @IsNumber()
  @IsOptional()
  specialAllowance?: number;

  @IsNumber()
  @IsOptional()
  medical?: number;

  @IsNumber()
  @IsOptional()
  travel?: number;

  @IsNumber()
  @IsOptional()
  internet?: number;

  @IsNumber()
  @IsOptional()
  foodAllowance?: number;

  @IsNumber()
  @IsOptional()
  bonus?: number;

  @IsNumber()
  @IsOptional()
  professionalTax?: number;

  @IsNumber()
  @IsOptional()
  pf?: number;

  @IsNumber()
  @IsOptional()
  esic?: number;

  @IsNumber()
  @IsOptional()
  tds?: number;

  @IsString()
  @IsOptional()
  effectiveDate?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  branchId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalaryComponentDto)
  @IsOptional()
  components?: CreateSalaryComponentDto[];
}
