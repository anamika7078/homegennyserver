import { IsInt, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';

export class QueuePayrollBatchDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  series?: string;
}
