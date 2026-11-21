import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { GroupAccess } from '../access/group-access.service';
import { DriftDetectedEvent, EVENT_DRIFT_DETECTED } from '../events/app-events';
import { PrismaService } from '../prisma/prisma.service';
import { SYNC_PORT, SyncPort } from '../sync/sync-port';

export type ScanStatus = 'OK' | 'DRIFT' | 'NOT_SYNCED' | 'ERROR';

const SCHEDULE_NAME = 'drift-scan';

/**
 * Scan drift terjadwal (PRD FR-25). Setiap interval, semua group yang punya padanan di cloud
 * dibandingkan dengan isinya di database. Hasilnya disimpan di group (last_scan_*).
 * drift.detected hanya dikirim saat status berubah menjadi DRIFT, supaya tidak berulang setiap jam.
 */
@Injectable()
export class ScanService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScanService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(SYNC_PORT) private readonly sync: SyncPort,
    private readonly events: EventEmitter2,
    private readonly access: GroupAccess,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    // SCAN_INTERVAL_MINUTES=0 (default) menonaktifkan scan terjadwal.
    const minutes = Number(this.config.get<string>('SCAN_INTERVAL_MINUTES') ?? 0);
    if (minutes > 0) {
      const handle = setInterval(() => void this.runScheduled(), minutes * 60_000);
      this.scheduler.addInterval(SCHEDULE_NAME, handle);
      this.logger.log(`Scan drift terjadwal setiap ${minutes} menit.`);
    }
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', SCHEDULE_NAME)) {
      this.scheduler.deleteInterval(SCHEDULE_NAME);
    }
  }

  /** Scan semua group yang punya padanan di cloud. Tidak berjalan dua kali bersamaan. */
  async runScheduled(): Promise<{ scanned: number }> {
    if (this.running) return { scanned: 0 };
    this.running = true;
    try {
      const groups = await this.prisma.securityGroup.findMany({
        where: { flociGroupId: { not: null } },
        select: { id: true },
      });
      for (const group of groups) {
        await this.scanGroup(group.id);
      }
      return { scanned: groups.length };
    } finally {
      this.running = false;
    }
  }

  /** Scan satu group atas permintaan user. Perlu akses minimal VIEWER. */
  async scanGroupAs(userId: string, groupId: string) {
    await this.access.require(userId, groupId, 'VIEWER');
    return this.scanGroup(groupId);
  }

  async scanGroup(groupId: string): Promise<{ status: ScanStatus; lastScanAt: Date }> {
    const before = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      select: { lastScanStatus: true },
    });
    if (!before) throw new Error(`group ${groupId} tidak ditemukan`);

    let status: ScanStatus;
    try {
      const report = await this.sync.inspect(groupId);
      status = report.status === 'IN_SYNC' ? 'OK' : report.status === 'DRIFT' ? 'DRIFT' : 'NOT_SYNCED';
      if (status === 'DRIFT' && before.lastScanStatus !== 'DRIFT') {
        await this.emitDrift(groupId, report.missingInCloud.length, report.extraInCloud.length, report.groupMissingInCloud);
      }
    } catch {
      status = 'ERROR';
    }

    const lastScanAt = new Date();
    await this.prisma.securityGroup.update({
      where: { id: groupId },
      data: { lastScanAt, lastScanStatus: status },
    });
    return { status, lastScanAt };
  }

  private async emitDrift(groupId: string, missing: number, extra: number, groupMissing: boolean): Promise<void> {
    const audience = await this.access.audienceOf(groupId);
    const group = await this.prisma.securityGroup.findUnique({ where: { id: groupId }, select: { name: true } });
    if (!audience || !group) return;
    const payload: DriftDetectedEvent = {
      ...audience,
      groupId,
      name: group.name,
      missingInCloud: missing,
      extraInCloud: extra,
      groupMissingInCloud: groupMissing,
    };
    this.events.emit(EVENT_DRIFT_DETECTED, payload);
  }
}
