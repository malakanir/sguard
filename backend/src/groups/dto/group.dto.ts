import { PartialType } from '@nestjs/mapped-types';
import { IsEmail, IsIn, IsInt, IsIP, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class CreateGroupDto {
  @IsString({ message: 'name harus berupa teks' })
  @IsNotEmpty({ message: 'name wajib diisi' })
  @MaxLength(80, { message: 'name maksimal 80 karakter' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'description harus berupa teks' })
  @MaxLength(500, { message: 'description maksimal 500 karakter' })
  description?: string;

  /** Akun AWS yang dipakai untuk sinkronisasi (FR-26). Kosong berarti Floci/stub. */
  @IsOptional()
  @IsUUID('all', { message: 'awsAccountId tidak valid' })
  awsAccountId?: string;
}

export class UpdateGroupDto extends PartialType(CreateGroupDto) {}

export class GroupListQueryDto extends PaginationQueryDto {}

export class SimulateDto {
  @IsIP(undefined, { message: 'sourceIp harus IPv4 atau IPv6 yang valid' })
  sourceIp!: string;

  @IsIn(['tcp', 'udp', 'icmp'], { message: 'protocol harus tcp, udp, atau icmp' })
  protocol!: 'tcp' | 'udp' | 'icmp';

  @IsOptional()
  @IsInt({ message: 'port harus bilangan bulat' })
  @Min(1, { message: 'port harus 1-65535' })
  @Max(65535, { message: 'port harus 1-65535' })
  port?: number;

  @IsOptional()
  @IsIn(['INGRESS', 'EGRESS'], { message: 'direction harus INGRESS atau EGRESS' })
  direction?: 'INGRESS' | 'EGRESS';
}

export class ShareGroupDto {
  @IsEmail({}, { message: 'email tidak valid' })
  email!: string;

  @IsIn(['VIEWER', 'EDITOR'], { message: 'role harus VIEWER atau EDITOR' })
  role!: 'VIEWER' | 'EDITOR';
}
