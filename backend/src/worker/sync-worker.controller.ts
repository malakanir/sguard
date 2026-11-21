import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import { RuleSpec } from '../risk/risk';
import { GroupRef, SYNC_PATTERNS } from '../sync/sync-port';
import { SyncService } from '../sync/sync.service';

/**
 * Handler di sync-worker. Setiap pola pesan memanggil SyncService yang sama dengan mode lokal,
 * jadi perilaku tidak berbeda antara dua mode.
 */
@Controller()
export class SyncWorkerController {
  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
  ) {}

  @MessagePattern(SYNC_PATTERNS.ensureGroup)
  async ensureGroup(@Payload() data: { groupId: string }) {
    await this.sync.ensureGroup(data.groupId);
    return { ok: true };
  }

  @MessagePattern(SYNC_PATTERNS.pushRule)
  async pushRule(@Payload() data: { ruleId: string; previous?: RuleSpec }) {
    await this.sync.pushRule(data.ruleId, data.previous);
    return { ok: true };
  }

  @MessagePattern(SYNC_PATTERNS.removeRule)
  async removeRule(@Payload() data: { rule: RuleSpec; group: GroupRef }) {
    await this.sync.removeRule(data.rule, data.group);
    return { ok: true };
  }

  @MessagePattern(SYNC_PATTERNS.removeGroup)
  async removeGroup(@Payload() data: { group: GroupRef }) {
    await this.sync.removeGroup(data.group);
    return { ok: true };
  }

  @MessagePattern(SYNC_PATTERNS.inspect)
  inspect(@Payload() data: { groupId: string }) {
    return this.sync.inspect(data.groupId);
  }

  @MessagePattern(SYNC_PATTERNS.repair)
  repair(@Payload() data: { groupId: string }) {
    return this.sync.repair(data.groupId);
  }
}
