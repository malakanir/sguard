import { Controller, Get, Query, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';

class ExportQueryDto {
  @IsIn(['csv', 'json'], { message: 'format harus csv atau json' })
  format: 'csv' | 'json' = 'csv';

  @IsOptional()
  @IsUUID('all', { message: 'groupId tidak valid' })
  groupId?: string;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('export')
  async export(
    @CurrentUser() user: AuthUser,
    @Query() query: ExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.reports.rows(user.id, query.groupId);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (query.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sguard-rules-${date}.json"`);
      return { generatedAt: new Date().toISOString(), count: rows.length, rules: rows };
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sguard-rules-${date}.csv"`);
    return this.reports.toCsv(rows);
  }
}
