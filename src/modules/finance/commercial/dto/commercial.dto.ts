import { Type } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';

/**
 * Were plain TypeScript interfaces before this — an interface erases to
 * `Object` at runtime, which the global ValidationPipe's `whitelist` /
 * `forbidNonWhitelisted` skip entirely (nothing to validate against), so
 * these three POST bodies got zero request validation despite the pipe
 * being configured strictly everywhere else. Confirmed live: posting a
 * calculation with a bogus customer_id plus unrelated extra fields sailed
 * straight through to a manual service-level 404, not a clean 400 — any
 * endpoint without its own guard would have hit a raw, unhandled Postgres
 * error instead.
 */
export class WageConfigDto {
  @IsString() state: string;
  @IsString() zone: string;
  @IsString() effective_date: string;
  @IsString() category: string;
  @IsNumber() basic_wage: number;
  @IsNumber() da: number;
  @IsNumber() hra: number;
  @IsNumber() skilled_allowance: number;
  @IsNumber() additional_hours_pct: number;
  @IsNumber() employer_pf_pct: number;
  @IsNumber() employer_pf_max: number;
  @IsNumber() employee_pf_pct: number;
  @IsNumber() employer_esic_pct: number;
  @IsNumber() employee_esic_pct: number;
  @IsNumber() bonus_pct: number;
  @IsNumber() leave_days: number;
  @IsNumber() lwf_pct: number;
  @IsNumber() lwf_max: number;
  @IsNumber() uniform_allowance: number;
  @IsNumber() relieving_pct: number;
  @IsNumber() management_pct: number;
  @IsNumber() training_charges: number;
  @IsNumber() gst_pct: number;
  @IsNumber() professional_tax: number;
  @IsNumber() nfh: number;

  @IsOptional() @IsString() status?: string;
  // ── Toggle flags ──
  @IsOptional() @IsBoolean() pf_applicable?: boolean;
  @IsOptional() @IsBoolean() esic_applicable?: boolean;
  @IsOptional() @IsBoolean() bonus_applicable?: boolean;
  @IsOptional() @IsString() bonus_frequency?: string; // 'monthly' | 'yearly'
  @IsOptional() @IsBoolean() lwf_applicable?: boolean;
  @IsOptional() @IsBoolean() uniform_applicable?: boolean;
  @IsOptional() @IsBoolean() relieving_applicable?: boolean;
  @IsOptional() @IsBoolean() nfh_applicable?: boolean;
  @IsOptional() @IsString() shift_pattern?: string; // '8' | '12'
  @IsOptional() @IsBoolean() gst_applicable?: boolean;
  @IsOptional() @IsString() gst_type?: string; // 'intra_state' | 'inter_state'
}

export class CalculationItemDto {
  @IsString() category: string;
  @IsNumber() no_of_resources: number;
  @IsNumber() working_hours: number;
  @IsString() shift_type: string;
  @IsOptional() @IsString() wage_config_id?: string;
}

export class CreateCalculationDto {
  @IsString() customer_id: string;
  @IsOptional() @IsString() branch_id?: string;
  @IsOptional() @IsString() branch_name?: string;
  @IsString() state: string;
  @IsString() zone: string;
  @IsNumber() contract_duration: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CalculationItemDto)
  items: CalculationItemDto[];
}

export class CreateQuotationDto {
  @IsString() calculation_id: string;
  @IsNumber() validity_days: number;
  @IsOptional() @IsString() terms_conditions?: string;
  @IsString() prepared_by: string;
}
