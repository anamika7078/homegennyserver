import { IsString, IsOptional, IsEmail, IsDateString, IsIn, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Only the phone is required (2026-10-21): the staff member signs up with a
 * mobile number and lands at S1_INTAKE; the RM calls them and fills in the
 * rest on "Complete S1". Every other field is still accepted (older app
 * builds send the full form) and is kept on the S1 record for the RM.
 */
export class RegisterStaffDto {
  @ApiProperty({ example: '9811100002', description: '10-15 digit phone number, optional leading +' })
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be a valid 10-15 digit number' })
  phone: string;

  @ApiPropertyOptional({ example: 'Pooja Mishra', minLength: 2, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name?: string;

  @ApiPropertyOptional({ example: '9811100099' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'alternate_phone must be a valid 10-15 digit number' })
  alternate_phone?: string;

  @ApiPropertyOptional({
    enum: ['UC', 'SC', 'CK'],
    example: 'UC',
    description: 'Work category, if the staff member picks one. Otherwise the RM sets it at S1. ' +
      'MAID and DR are still recognised but refused while those series are paused.',
  })
  // Every known code passes here so a paused series gets the clear "not being
  // taken on" message from assertSeriesActive(), not a bare enum error.
  @IsOptional()
  @IsIn(['UC', 'SC', 'CK', 'COOK', 'UNSKILLED_CARE', 'SKILLED_CARE', 'MAID', 'DR', 'DRIVER'])
  series?: string;

  @ApiPropertyOptional({ example: 'pooja@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: 'Str0ng@Pass',
    description:
      'Optional — without it the account signs in with a mobile OTP only. If given: 8-72 chars, upper, lower, ' +
      'digit and one of @ $ ! % * ? & # - _',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#\-_])[A-Za-z\d@$!%*?&#\-_]{8,72}$/, {
    message: 'password must contain at least 8 characters, including uppercase, lowercase, a number, and a special symbol (@, $, !, %, *, ?, &, #, -, _)',
  })
  password?: string;

  @ApiPropertyOptional({ example: '1995-06-15', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_of_birth?: string;

  @ApiPropertyOptional({ enum: ['MALE', 'FEMALE', 'OTHER'], example: 'FEMALE' })
  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;

  @ApiPropertyOptional({ example: 'C-45, Sector 62, Noida', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  address?: string;

  @ApiPropertyOptional({ example: 'Noida', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'Uttar Pradesh', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ example: '201301', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  pincode?: string;
}
