import { IsInt, IsOptional, IsString, IsUUID, Min, Max } from 'class-validator';

export class ProcessEnterpriseBatchDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @IsString()
  @IsOptional()
  branchId?: string;
}

export class ApproveBatchTierDto {
  @IsString()
  tier: string; // e.g. 'LEVEL_1_HR', 'LEVEL_2_FINANCE', 'LEVEL_3_ADMIN'

  @IsString()
  @IsOptional()
  comments?: string;
}

export class GenerateBankTransferDto {
  @IsString()
  @IsOptional()
  format?: string; // 'CSV' | 'EXCEL'
}

export class UpdatePayrollSettingDto {
  @IsString()
  settingKey: string;

  @IsOptional()
  settingValue: any;

  @IsString()
  @IsOptional()
  description?: string;
}
