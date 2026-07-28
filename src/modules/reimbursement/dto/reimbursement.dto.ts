import { IsString, IsNumber, IsOptional, IsUUID, IsEnum } from 'class-validator';
import { ReimbursementStatus } from '@prisma/client';

export class CreateReimbursementDto {
  @IsUUID()
  employeeId: string;

  @IsString()
  category: string;

  @IsNumber()
  amount: number;

  @IsString()
  expenseDate: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  billUrl?: string;
}

export class UpdateReimbursementStatusDto {
  @IsEnum(ReimbursementStatus)
  status: ReimbursementStatus;

  @IsString()
  @IsOptional()
  approvalRole?: 'manager' | 'finance' | 'payroll';

  @IsString()
  @IsOptional()
  rejectionReason?: string;
}
