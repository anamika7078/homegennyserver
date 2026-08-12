import { IsString, IsOptional, IsEmail, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterCustomerDto {
  @ApiProperty({ example: 'Anita Sharma', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name: string;

  @ApiProperty({ example: '9811100001', description: '10-15 digit phone number, optional leading +' })
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be a valid 10-15 digit number' })
  phone: string;

  @ApiPropertyOptional({ example: 'anita@example.com' })
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

  @ApiPropertyOptional({ example: 'Sharma Residence', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  business_name?: string;

  @ApiProperty({ example: 'ABCDE1234F', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  pan_card: string;

  @ApiProperty({ example: 'B-12, Sector 44, Noida', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  address: string;

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

  @ApiPropertyOptional({ example: '09ABCDE1234F1Z5', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  gstn?: string;
}
