import { IsEmail, IsString, MaxLength, MinLength, IsNotEmpty } from 'class-validator';

export class RegisterDto {
  @IsString({ message: 'name harus berupa teks' })
  @IsNotEmpty({ message: 'name wajib diisi' })
  @MaxLength(80, { message: 'name maksimal 80 karakter' })
  name!: string;

  @IsEmail({}, { message: 'email tidak valid' })
  email!: string;

  @IsString({ message: 'password harus berupa teks' })
  @MinLength(8, { message: 'password minimal 8 karakter' })
  @MaxLength(72, { message: 'password maksimal 72 karakter' })
  password!: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'email tidak valid' })
  email!: string;

  @IsString({ message: 'password wajib diisi' })
  @IsNotEmpty({ message: 'password wajib diisi' })
  password!: string;
}

export class RefreshDto {
  @IsString({ message: 'refreshToken wajib diisi' })
  @IsNotEmpty({ message: 'refreshToken wajib diisi' })
  refreshToken!: string;
}
