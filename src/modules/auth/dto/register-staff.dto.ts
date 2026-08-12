import { IsString, IsOptional, IsEmail, IsDateString, IsIn, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterStaffDto {
  @ApiProperty({ example: 'Pooja Mishra', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name: string;

  @ApiProperty({ example: '9811100002', description: '10-15 digit phone number, optional leading +' })
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be a valid 10-15 digit number' })
  phone: string;

  @ApiPropertyOptional({ example: '9811100099' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'alternate_phone must be a valid 10-15 digit number' })
  alternate_phone?: string;

  @ApiPropertyOptional({ example: 'pooja@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'Str0ng@Pass',
    description: '8-72 chars, at least one uppercase, one lowercase, one digit, one special symbol (@ $ ! % * ? & # - _)',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#\-_])[A-Za-z\d@$!%*?&#\-_]{8,72}$/, {
    message: 'password must contain at least 8 characters, including uppercase, lowercase, a number, and a special symbol (@, $, !, %, *, ?, &, #, -, _)',
  })
  password: string;

  @ApiProperty({ example: '1995-06-15', description: 'ISO date string' })
  @IsDateString()
  date_of_birth: string;

  @ApiProperty({ enum: ['MALE', 'FEMALE', 'OTHER'], example: 'FEMALE' })
  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender: string;

  @ApiProperty({ example: 'C-45, Sector 62, Noida', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  address: string;

  @ApiProperty({ example: 'Noida', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  city: string;

  @ApiProperty({ example: 'Uttar Pradesh', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  state: string;

  @ApiProperty({ example: '201301', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  pincode: string;
}
