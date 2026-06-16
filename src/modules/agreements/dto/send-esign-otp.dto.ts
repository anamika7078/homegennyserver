import { IsUUID, IsIn, IsString, MinLength, MaxLength } from 'class-validator';

export class SendEsignOtpDto {
  @IsUUID('4')
  staff_id: string;

  @IsIn(['A1', 'A2', 'A3', 'A4', 'A5'])
  agreement_type: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  staff_name: string;
}
