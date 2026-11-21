import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FirewallRule, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Direction, RuleSpec } from '../risk/risk';
import { CloudClient, errorCode, IDEMPOTENT_CODES, ruleKey } from './cloud-client';
import { CloudClientResolver } from './cloud-client-resolver';
import { SyncPort } from './sync-port';

export interface DriftItem {
  id?: string;
  name?: string;
  direction: Direction;
  protocol: RuleSpec['protocol'];
  port: number | null;
  portTo: number | null;
  cidr: string;
}

export interface DriftReport {
  /** NOT_SYNCED: group belum punya padanan di cloud. */
  status: 'NOT_SYNCED' | 'IN_SYNC' | 'DRIFT';
  /** Rule di database yang tidak ada di cloud. */
  missingInCloud: DriftItem[];
  /** Rule di cloud yang tidak ada di database. */
  extraInCloud: DriftItem[];
  /** Rule cloud di luar cakupan (misalnya protocol -1). Hanya dilaporkan, tidak diubah. */
  unmanagedInCloud: number;
  /** Security Group sudah tidak ada di cloud (misalnya dihapus langsung di Floci atau AWS). */
  groupMissingInCloud: boolean;
}

interface GroupRef {
  flociGroupId: string | null;
  awsAccountId?: string | null;
}

function shortError(err: unknown): string {
  // Koneksi gagal di AWS SDK sering berupa AggregateError tanpa pesan; ambil pesan dari penyebabnya.
  const inner = err instanceof AggregateError ? err.errors[0] : undefined;
  const source = inner instanceof Error ? inner : err;
  let message = source instanceof Error ? source.message : String(source);
  if (!message) message = 'cloud tidak terjangkau';
  return `${errorCode(source)}: ${message}`.slice(0, 200);
}

function specOf(rule: Pick<FirewallRule, 'direction' | 'protocol' | 'port' | 'portTo' | 'cidr'>): RuleSpec {
  return { direction: rule.direction, protocol: rule.protocol, port: rule.port, portTo: rule.portTo, cidr: rule.cidr };
}

function driftItemOf(rule: Pick<FirewallRule, 'id' | 'name' | 'direction' | 'protocol' | 'port' | 'portTo' | 'cidr'>): DriftItem {
  return {
    id: rule.id,
    name: rule.name,
    direction: rule.direction,
    protocol: rule.protocol,
    port: rule.port,
    portTo: rule.portTo,
    cidr: rule.cidr,
  };
}

/**
 * Satu-satunya tempat yang memanggil cloud. Kegagalan tidak melempar error ke controller;
 * hanya disimpan sebagai status FAILED supaya CRUD tetap jalan.
 */
@Injectable()
export class SyncService implements SyncPort {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: CloudClientResolver,
  ) {}

  /** Pastikan group ada di cloud, lalu terapkan semua rule yang belum SYNCED. */
  async ensureGroup(groupId: string): Promise<void> {
    const group = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      include: { rules: { orderBy: { createdAt: 'asc' } } },
    });
    if (!group) return;

    const cloud = await this.clients.forAccount(group.awsAccountId);
    let cloudId = group.flociGroupId;
    if (!cloudId) {
      try {
        cloudId = await cloud.createGroup(`sguard-${group.id}`, group.description ?? group.name);
      } catch (err) {
        const message = shortError(err);
        this.logger.warn(`Gagal membuat group ${group.id} di cloud: ${message}`);
        await this.prisma.securityGroup.update({
          where: { id: group.id },
          data: { syncStatus: SyncStatus.FAILED, syncError: message },
        });
        // Rule di group ini belum bisa dikirim; tandai FAILED supaya statusnya jujur.
        await this.prisma.firewallRule.updateMany({
          where: { securityGroupId: group.id, syncStatus: { not: SyncStatus.SYNCED } },
          data: { syncStatus: SyncStatus.FAILED, syncError: message },
        });
        return;
      }
      await this.prisma.securityGroup.update({
        where: { id: group.id },
        data: { flociGroupId: cloudId, syncStatus: SyncStatus.SYNCED, syncError: null },
      });
    }

    for (const rule of group.rules) {
      if (rule.syncStatus !== SyncStatus.SYNCED) {
        await this.applyRule(cloud, rule.id, cloudId, specOf(rule));
      }
    }
  }

  /** Kirim satu rule ke cloud. Dipanggil setelah rule dibuat atau diubah. */
  async pushRule(ruleId: string, previous?: RuleSpec): Promise<void> {
    const rule = await this.prisma.firewallRule.findUnique({
      where: { id: ruleId },
      include: { group: true },
    });
    if (!rule) return;

    const cloudId = rule.group.flociGroupId;
    if (!cloudId) {
      // Group belum punya padanan di cloud: buat dulu, sekalian kirim rule ini.
      await this.ensureGroup(rule.securityGroupId);
      return;
    }

    const cloud = await this.clients.forAccount(rule.group.awsAccountId);
    if (previous) {
      await this.revokeQuietly(cloud, cloudId, previous);
    }
    await this.applyRule(cloud, rule.id, cloudId, specOf(rule));
  }

  /** Hapus rule di cloud sebelum rule dihapus dari database. Kegagalan hanya dicatat. */
  async removeRule(rule: RuleSpec, group: GroupRef): Promise<void> {
    if (!group.flociGroupId) return;
    const cloud = await this.clients.forAccount(group.awsAccountId);
    await this.revokeQuietly(cloud, group.flociGroupId, rule);
  }

  /** Hapus group di cloud sebelum group dihapus dari database. */
  async removeGroup(group: GroupRef): Promise<void> {
    if (!group.flociGroupId) return;
    try {
      const cloud = await this.clients.forAccount(group.awsAccountId);
      await cloud.deleteGroup(group.flociGroupId);
    } catch (err) {
      if (errorCode(err) !== 'InvalidGroup.NotFound') {
        this.logger.warn(`Gagal menghapus group ${group.flociGroupId} di cloud: ${shortError(err)}`);
      }
    }
  }

  /** Bandingkan isi database dengan cloud. Read-only. */
  async inspect(groupId: string): Promise<DriftReport> {
    const group = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      include: { rules: true },
    });
    const notSynced: DriftReport = {
      status: 'NOT_SYNCED',
      missingInCloud: [],
      extraInCloud: [],
      unmanagedInCloud: 0,
      groupMissingInCloud: false,
    };
    if (!group || !group.flociGroupId) return notSynced;

    const cloud = await this.clients.forAccount(group.awsAccountId);
    let described;
    try {
      described = await cloud.describe(group.flociGroupId);
    } catch (err) {
      if (errorCode(err) === 'InvalidGroup.NotFound') {
        // Group hilang di cloud: semua rule di database dianggap hilang.
        return {
          status: 'DRIFT',
          missingInCloud: group.rules.map(driftItemOf),
          extraInCloud: [],
          unmanagedInCloud: 0,
          groupMissingInCloud: true,
        };
      }
      throw new ServiceUnavailableException(`Cloud tidak terjangkau: ${shortError(err)}`);
    }

    const cloudKeys = new Set(described.rules.map(ruleKey));
    const dbKeys = new Set(group.rules.map((r) => ruleKey(specOf(r))));
    const missingInCloud = group.rules.filter((r) => !cloudKeys.has(ruleKey(specOf(r)))).map(driftItemOf);
    const extraInCloud = described.rules
      .filter((r) => !dbKeys.has(ruleKey(r)))
      .map((r) => ({
        direction: r.direction ?? 'INGRESS',
        protocol: r.protocol,
        port: r.port,
        portTo: r.portTo ?? null,
        cidr: r.cidr,
      }));

    const drift = missingInCloud.length > 0 || extraInCloud.length > 0;
    return {
      status: drift ? 'DRIFT' : 'IN_SYNC',
      missingInCloud,
      extraInCloud,
      unmanagedInCloud: described.unsupported,
      groupMissingInCloud: false,
    };
  }

  /**
   * Perbaiki drift lewat sync ulang (PRD FR-18): cabut rule asing di cloud,
   * lalu kirim ulang rule yang hilang. Rule di luar cakupan tidak disentuh.
   */
  async repair(groupId: string): Promise<DriftReport> {
    const report = await this.inspect(groupId);
    if (report.status === 'NOT_SYNCED') {
      await this.ensureGroup(groupId);
      return this.inspect(groupId);
    }
    if (report.status === 'IN_SYNC') return report;

    if (report.groupMissingInCloud) {
      // Buat ulang group di cloud, lalu kirim semua rule dari database.
      await this.prisma.securityGroup.update({
        where: { id: groupId },
        data: { flociGroupId: null, syncStatus: SyncStatus.PENDING, syncError: null },
      });
      await this.prisma.firewallRule.updateMany({
        where: { securityGroupId: groupId },
        data: { syncStatus: SyncStatus.PENDING, syncError: null },
      });
      await this.ensureGroup(groupId);
      return this.inspect(groupId);
    }

    const group = await this.prisma.securityGroup.findUniqueOrThrow({ where: { id: groupId } });
    const cloud = await this.clients.forAccount(group.awsAccountId);
    for (const extra of report.extraInCloud) {
      await this.revokeQuietly(cloud, group.flociGroupId as string, extra);
    }
    if (report.missingInCloud.length > 0) {
      await this.prisma.firewallRule.updateMany({
        where: { id: { in: report.missingInCloud.map((r) => r.id as string) } },
        data: { syncStatus: SyncStatus.PENDING, syncError: null },
      });
      await this.ensureGroup(groupId);
    }
    return this.inspect(groupId);
  }

  private async applyRule(cloud: CloudClient, ruleId: string, cloudId: string, spec: RuleSpec): Promise<void> {
    try {
      await cloud.authorize(cloudId, spec);
      await this.prisma.firewallRule.update({
        where: { id: ruleId },
        data: { syncStatus: SyncStatus.SYNCED, syncError: null },
      });
    } catch (err) {
      if (IDEMPOTENT_CODES.has(errorCode(err))) {
        // Rule sudah ada di cloud: anggap berhasil.
        await this.prisma.firewallRule.update({
          where: { id: ruleId },
          data: { syncStatus: SyncStatus.SYNCED, syncError: null },
        });
        return;
      }
      this.logger.warn(`Gagal sync rule ${ruleId}: ${shortError(err)}`);
      await this.prisma.firewallRule.update({
        where: { id: ruleId },
        data: { syncStatus: SyncStatus.FAILED, syncError: shortError(err) },
      });
    }
  }

  private async revokeQuietly(cloud: CloudClient, cloudId: string, spec: RuleSpec): Promise<void> {
    try {
      await cloud.revoke(cloudId, spec);
    } catch (err) {
      if (!IDEMPOTENT_CODES.has(errorCode(err))) {
        this.logger.warn(`Gagal mencabut rule di cloud: ${shortError(err)}`);
      }
    }
  }
}
