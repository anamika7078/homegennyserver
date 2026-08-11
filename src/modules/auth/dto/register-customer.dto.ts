import { IsString, IsOptional, IsEmail, MinLength, MaxLength, Matches } from 'class-validator';

export class RegisterCustomerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name: string;

  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be a valid 10-15 digit number' })
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#\-_])[A-Za-z\d@$!%*?&#\-_]{8,72}$/, {
    message: 'password must contain at least 8 characters, including uppercase, lowercase, a number, and a special symbol (@, $, !, %, *, ?, &, #, -, _)',
  })
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  business_name?: string;

  @IsString()
  @MaxLength(20)
  pan_card: string;

  @IsString()
  @MaxLength(2000)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  pincode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  gstn?: string;
}
