import { IsString, IsNumber, IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class CreateOvertimeRuleDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  department?: string;

  @IsNumber()
  hourlyRate: number;

  @IsNumber()
  @IsOptional()
  weekendRateMulti?: number;

  @IsNumber()
  @IsOptional()
  holidayRateMulti?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateOvertimeRuleDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  department?: string;

  @IsNumber()
  @IsOptional()
  hourlyRate?: number;

  @IsNumber()
  @IsOptional()
  weekendRateMulti?: number;

  @IsNumber()
  @IsOptional()
  holidayRateMulti?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateOvertimeRecordDto {
  @IsUUID()
  employeeId: string;

  @IsString()
  date: string;

  @IsNumber()
  hours: number;

  @IsNumber()
  @IsOptional()
  rateMultiplier?: number;

  @IsNumber()
  @IsOptional()
  totalAmount?: number;

  @IsBoolean()
  @IsOptional()
  isWeekend?: boolean;

  @IsBoolean()
  @IsOptional()
  isHoliday?: boolean;

  @IsString()
  @IsOptional()
  status?: string;
}
