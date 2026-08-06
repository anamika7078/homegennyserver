import { IsString, IsOptional, IsEmail, IsDateString, IsIn, MinLength, MaxLength, Matches } from 'class-validator';

export class RegisterStaffDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name: string;

  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be a valid 10-15 digit number' })
  phone: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'alternate_phone must be a valid 10-15 digit number' })
  alternate_phone?: string;

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

  @IsDateString()
  date_of_birth: string;

  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender: string;

  @IsString()
  @MaxLength(2000)
  address: string;

  @IsString()
  @MaxLength(100)
  city: string;

  @IsString()
  @MaxLength(100)
  state: string;

  @IsString()
  @MaxLength(20)
  pincode: string;
}
