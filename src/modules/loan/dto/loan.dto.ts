import { IsString, IsNumber, IsBoolean, IsOptional, IsUUID, IsInt, IsEnum } from 'class-validator';
import { LoanStatus } from '@prisma/client';

export class CreateEmployeeLoanDto {
  @IsUUID()
  employeeId: string;

  @IsNumber()
  loanAmount: number;

  @IsNumber()
  monthlyEmi: number;

  @IsNumber()
  @IsOptional()
  interestRate?: number;

  @IsString()
  startDate: string;

  @IsBoolean()
  @IsOptional()
  autoDeduction?: boolean;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class CreateSalaryAdvanceDto {
  @IsUUID()
  employeeId: string;

  @IsNumber()
  amount: number;

  @IsInt()
  recoveryMonth: number;

  @IsInt()
  recoveryYear: number;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class UpdateLoanStatusDto {
  @IsEnum(LoanStatus)
  status: LoanStatus;
}
