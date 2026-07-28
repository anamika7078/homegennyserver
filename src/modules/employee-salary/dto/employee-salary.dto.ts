import { IsString, IsNumber, IsOptional, IsUUID } from 'class-validator';

export class AssignSalaryProfileDto {
  @IsUUID()
  employeeId: string;

  @IsUUID()
  @IsOptional()
  templateId?: string;

  @IsNumber()
  grossSalary: number;

  @IsString()
  @IsOptional()
  bankName?: string;

  @IsString()
  @IsOptional()
  accountNumber?: string;

  @IsString()
  @IsOptional()
  ifsc?: string;

  @IsString()
  @IsOptional()
  pan?: string;

  @IsString()
  @IsOptional()
  panNumber?: string;

  @IsString()
  @IsOptional()
  uan?: string;

  @IsString()
  @IsOptional()
  pfUan?: string;

  @IsString()
  @IsOptional()
  esicNumber?: string;
}

export class CreateSalaryRevisionDto {
  @IsNumber()
  newGross: number;

  @IsNumber()
  @IsOptional()
  incrementAmount?: number;

  @IsNumber()
  @IsOptional()
  incrementPercent?: number;

  @IsString()
  @IsOptional()
  revisionType?: string; // e.g. INCREMENT, PROMOTION, ADJUSTMENT

  @IsString()
  effectiveDate: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsUUID()
  @IsOptional()
  approvedBy?: string;
}
