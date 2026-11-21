import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { paginate } from '../common/pagination';
import { GroupAccess } from '../access/group-access.service';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  userId: string;
  securityGroupId: string | null;
  ruleId: string | null;
  action: AuditAction;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
}

/**
 * Audit log hanya bisa ditambah. Tidak ada method update atau delete di sini,
 * dan tidak ada endpoint yang mengubah atau menghapusnya (PRD bagian 6).
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccess,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.ruleAuditLog.create({
      data: {
        userId: entry.userId,
        securityGroupId: entry.securityGroupId,
        ruleId: entry.ruleId,
        action: entry.action,
        before: entry.before ?? Prisma.JsonNull,
        after: entry.after ?? Prisma.JsonNull,
      },
    });
  }

  async list(userId: string, query: { groupId?: string; ruleId?: string; page: number; limit: number }) {
    // Riwayat yang bisa dilihat: perubahan sendiri, dan perubahan pada group yang bisa diakses.
    const groupIds = await this.access.accessibleGroupIds(userId);
    const where: Prisma.RuleAuditLogWhereInput = {
      AND: [
        { OR: [{ userId }, { securityGroupId: { in: groupIds } }] },
        ...(query.groupId ? [{ securityGroupId: query.groupId }] : []),
        ...(query.ruleId ? [{ ruleId: query.ruleId }] : []),
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.ruleAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.ruleAuditLog.count({ where }),
    ]);
    return paginate(items, total, query.page, query.limit);
  }
}
