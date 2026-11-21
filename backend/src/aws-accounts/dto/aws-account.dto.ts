import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

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

  /** ARN peran IAM yang di-assume via STS. Kosong berarti memakai access key statis saja. */
  @IsOptional()
  @IsString()
  @Matches(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/, { message: 'roleArn tidak valid' })
  roleArn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  externalId?: string;

  @IsOptional()
  @IsInt({ message: 'sessionDuration harus bilangan bulat' })
  @Min(900, { message: 'sessionDuration minimal 900 detik' })
  @Max(43200, { message: 'sessionDuration maksimal 43200 detik' })
  sessionDuration?: number;
}
