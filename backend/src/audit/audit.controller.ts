import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('all', { message: 'groupId tidak valid' })
  groupId?: string;

  @IsOptional()
  @IsUUID('all', { message: 'ruleId tidak valid' })
  ruleId?: string;
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: AuditQueryDto) {
    return this.audit.list(user.id, {
      groupId: query.groupId,
      ruleId: query.ruleId,
      page: query.page,
      limit: query.limit,
    });
  }
}
