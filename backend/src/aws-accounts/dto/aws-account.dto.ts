import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAwsAccountDto {
  @IsString({ message: 'name harus berupa teks' })
  @IsNotEmpty({ message: 'name wajib diisi' })
  @MaxLength(80, { message: 'name maksimal 80 karakter' })
  name!: string;

  @Matches(/^[a-z]{2}(-[a-z]+)+-\d$/, { message: 'region tidak valid, misalnya ap-southeast-1' })
  region!: string;

  @IsString()
  @MinLength(16, { message: 'accessKeyId tidak valid' })
  @MaxLength(128)
  accessKeyId!: string;

  @IsString()
  @MinLength(16, { message: 'secretAccessKey tidak valid' })
  @MaxLength(256)
  secretAccessKey!: string;
}
