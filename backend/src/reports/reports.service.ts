import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReportRow {
  group: string;
  rule: string;
  protocol: string;
  port: number | null;
  cidr: string;
  riskLevel: string;
  riskReason: string | null;
  recommendation: string | null;
  syncStatus: string;
  description: string | null;
  updatedAt: string;
}

const HEADERS: (keyof ReportRow)[] = [
  'group',
  'rule',
  'protocol',
  'port',
  'cidr',
  'riskLevel',
  'riskReason',
  'recommendation',
  'syncStatus',
  'description',
  'updatedAt',
];

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hanya data milik user yang login (PRD bagian 4). */
  async rows(userId: string, groupId?: string): Promise<ReportRow[]> {
    if (groupId) {
      const owned = await this.prisma.securityGroup.findFirst({ where: { id: groupId, userId } });
      if (!owned) throw new NotFoundException('Security group tidak ditemukan.');
    }
    const rules = await this.prisma.firewallRule.findMany({
      where: { group: { userId }, ...(groupId ? { securityGroupId: groupId } : {}) },
      include: { group: { select: { name: true } } },
      orderBy: [{ group: { name: 'asc' } }, { name: 'asc' }],
    });
    return rules.map((r) => ({
      group: r.group.name,
      rule: r.name,
      protocol: r.protocol,
      port: r.port,
      cidr: r.cidr,
      riskLevel: r.riskLevel,
      riskReason: r.riskReason,
      recommendation: r.recommendation,
      syncStatus: r.syncStatus,
      description: r.description,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  toCsv(rows: ReportRow[]): string {
    const lines = [HEADERS.join(',')];
    for (const row of rows) {
      lines.push(HEADERS.map((h) => csvCell(row[h])).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }
}

/** Escape CSV dan tambah apostrof bila sel diawali karakter formula (CSV injection). */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
