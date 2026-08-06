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
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one number',
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
