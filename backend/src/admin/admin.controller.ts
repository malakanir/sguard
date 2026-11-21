import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Endpoint ADMIN hanya mengembalikan angka agregat dan metadata user.
 * Isi rule milik user lain tidak pernah dikembalikan (PRD FR-17).
 */
@Controller('admin')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary() {
    const [users, groups, rules, byRisk, bySync] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.securityGroup.count(),
      this.prisma.firewallRule.count(),
      this.prisma.firewallRule.groupBy({ by: ['riskLevel'], _count: { _all: true } }),
      this.prisma.firewallRule.groupBy({ by: ['syncStatus'], _count: { _all: true } }),
    ]);
    const toMap = (rows: { _count: { _all: number } }[], key: (r: never) => string) =>
      Object.fromEntries(rows.map((r) => [key(r as never), r._count._all]));
    return {
      totalUsers: users,
      totalGroups: groups,
      totalRules: rules,
      rulesByRisk: toMap(byRisk as never, (r: { riskLevel: string }) => r.riskLevel),
      rulesBySyncStatus: toMap(bySync as never, (r: { syncStatus: string }) => r.syncStatus),
    };
  }

  @Get('users')
  async users(@Query() query: PaginationQueryDto) {
    const { page, limit, search } = query;
    const where = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          _count: { select: { groups: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    const data = await Promise.all(
      items.map(async ({ _count, ...user }) => ({
        ...user,
        groupCount: _count.groups,
        ruleCount: await this.prisma.firewallRule.count({ where: { group: { userId: user.id } } }),
      })),
    );
    return paginate(data, total, page, limit);
  }
}
