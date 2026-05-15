import { IsOptional, IsString, MaxLength, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';

const ACTION_STATUS_VALUES = [
  'in_progress',
  'resolved',
  'escalate_director',
  'snooze_24h',
  'close_no_action',
] as const;

export class AlarmActionDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsString()
  @MaxLength(8000)
  bm_note?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsString()
  @IsIn([...ACTION_STATUS_VALUES])
  bm_action_status?: string;
}
