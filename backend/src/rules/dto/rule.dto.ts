import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const PORT_RULES = { message: 'port harus 1-65535' };

export class CreateRuleDto {
  @IsString({ message: 'name harus berupa teks' })
  @IsNotEmpty({ message: 'name wajib diisi' })
  @MaxLength(100, { message: 'name maksimal 100 karakter' })
  name!: string;

  @IsOptional()
  @IsIn(['INGRESS', 'EGRESS'], { message: 'direction harus INGRESS atau EGRESS' })
  direction?: 'INGRESS' | 'EGRESS';

  @IsIn(['tcp', 'udp', 'icmp'], { message: 'protocol harus tcp, udp, atau icmp' })
  protocol!: 'tcp' | 'udp' | 'icmp';

  @IsOptional()
  @IsInt({ message: 'port harus bilangan bulat' })
  @Min(1, PORT_RULES)
  @Max(65535, PORT_RULES)
  port?: number | null;

  /** Ujung rentang port (opsional). Jika kosong, rule berisi satu port. */
  @IsOptional()
  @IsInt({ message: 'portTo harus bilangan bulat' })
  @Min(1, PORT_RULES)
  @Max(65535, PORT_RULES)
  portTo?: number | null;

  /** CIDR IPv4 atau IPv6. Format divalidasi di service agar pesannya jelas. */
  @IsString({ message: 'cidr harus berupa teks' })
  @IsNotEmpty({ message: 'cidr wajib diisi' })
  @MaxLength(64)
  cidr!: string;

  @IsOptional()
  @IsString({ message: 'description harus berupa teks' })
  @MaxLength(500, { message: 'description maksimal 500 karakter' })
  description?: string;
}

export class UpdateRuleDto extends PartialType(CreateRuleDto) {}

export class RuleListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['HIGH', 'MEDIUM', 'LOW'], { message: 'risk harus HIGH, MEDIUM, atau LOW' })
  risk?: 'HIGH' | 'MEDIUM' | 'LOW';

  @IsOptional()
  @IsUUID('all', { message: 'groupId tidak valid' })
  groupId?: string;
}
