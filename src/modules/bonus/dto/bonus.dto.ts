import { IsString, IsNumber, IsBoolean, IsOptional, IsUUID, IsInt } from 'class-validator';

export class CreateBonusRecordDto {
  @IsUUID()
  employeeId: string;

  @IsString()
  category: string;

  @IsNumber()
  amount: number;

  @IsInt()
  month: number;

  @IsInt()
  year: number;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class UpdateBonusRecordDto {
  @IsString()
  @IsOptional()
  category?: string;

  @IsNumber()
  @IsOptional()
  amount?: number;

  @IsInt()
  @IsOptional()
  month?: number;

  @IsInt()
  @IsOptional()
  year?: number;

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  reason?: string;
}
