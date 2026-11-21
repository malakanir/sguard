import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { GroupAccess } from '../access/group-access.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccess,
  ) {}

  @Get('summary')
  async summary(@CurrentUser() user: AuthUser) {
    const groups = await this.prisma.securityGroup.findMany({
      where: this.access.accessibleWhere(user.id),
      orderBy: { name: 'asc' },
      select: { id: true, name: true, rules: { select: { riskLevel: true } } },
    });

    const total = { HIGH: 0, MEDIUM: 0, LOW: 0, all: 0 };
    const perGroup = groups.map((group) => {
      const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const rule of group.rules) {
        counts[rule.riskLevel] += 1;
        total[rule.riskLevel] += 1;
        total.all += 1;
      }
      return { groupId: group.id, name: group.name, ...counts, total: group.rules.length };
    });

    return { total, perGroup };
  }
}
