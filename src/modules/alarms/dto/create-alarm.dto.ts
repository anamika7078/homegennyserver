import { IsString, IsOptional, MaxLength, IsIn, IsBoolean, IsEnum } from 'class-validator';
import { AlarmSeverity } from '../alarm.entity';

const CATEGORIES = ['CLIENT', 'COMPLIANCE', 'PAYMENT', 'SYSTEM'] as const;

export class CreateAlarmDto {
  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  description?: string;

  @IsEnum(AlarmSeverity)
  severity: AlarmSeverity;

  @IsIn([...CATEGORIES])
  category: (typeof CATEGORIES)[number];

  @IsString()
  @MaxLength(32)
  ref_code: string;

  @IsString()
  @MaxLength(8000)
  list_meta: string;

  @IsString()
  @MaxLength(2000)
  list_footer: string;

  @IsString()
  @MaxLength(120)
  assigned_to: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  detail_meta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  recommended_action?: string;

  @IsOptional()
  @IsBoolean()
  is_read?: boolean;
}
