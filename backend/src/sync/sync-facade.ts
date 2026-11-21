import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GroupAccess } from '../access/group-access.service';
import { EVENT_SYNC_CHANGED, GroupEventBase, SyncChangedEvent } from '../events/app-events';
import { PrismaService } from '../prisma/prisma.service';
import { RuleSpec } from '../risk/risk';
import { DriftReport } from './sync.service';
import { GroupRef, SYNC_BACKEND, SyncPort } from './sync-port';

interface StatusEntry {
  groupId: string;
  ruleId: string | null;
  kind: 'group' | 'rule';
  name: string;
  status: string;
  error: string | null;
}

/**
 * Membungkus SyncPort: sebelum dan sesudah setiap operasi, status group dan rule dibandingkan.
 * Setiap perubahan dikirim sebagai event sync.changed (PRD FR-20). Berlaku sama untuk
 * mode lokal maupun sync-worker, karena event dipancarkan di API.
 */
@Injectable()
export class SyncFacade implements SyncPort {
  constructor(
    @Inject(SYNC_BACKEND) private readonly backend: SyncPort,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly access: GroupAccess,
  ) {}

  ensureGroup(groupId: string): Promise<void> {
    return this.observe(groupId, () => this.backend.ensureGroup(groupId));
  }

  async pushRule(ruleId: string, previous?: RuleSpec): Promise<void> {
    const rule = await this.prisma.firewallRule.findUnique({
      where: { id: ruleId },
      select: { securityGroupId: true },
    });
    if (!rule) return this.backend.pushRule(ruleId, previous);
    return this.observe(rule.securityGroupId, () => this.backend.pushRule(ruleId, previous));
  }

  removeRule(rule: RuleSpec, group: GroupRef): Promise<void> {
    return this.backend.removeRule(rule, group);
  }

  removeGroup(group: GroupRef): Promise<void> {
    return this.backend.removeGroup(group);
  }

  inspect(groupId: string): Promise<DriftReport> {
    return this.backend.inspect(groupId);
  }

  repair(groupId: string): Promise<DriftReport> {
    return this.observe(groupId, () => this.backend.repair(groupId));
  }

  private async observe<T>(groupId: string, op: () => Promise<T>): Promise<T> {
    const before = await this.snapshot(groupId);
    const result = await op();
    const after = await this.snapshot(groupId);
    const audience = await this.access.audienceOf(groupId);

    for (const [key, entry] of after) {
      const previous = before.get(key);
      if (previous && previous.status === entry.status && previous.error === entry.error) continue;
      if (!audience) continue;
      const base: GroupEventBase = { ownerId: audience.ownerId, audience: audience.audience, groupId: entry.groupId };
      const payload: SyncChangedEvent = {
        ...base,
        ruleId: entry.ruleId,
        kind: entry.kind,
        name: entry.name,
        status: entry.status as SyncChangedEvent['status'],
        error: entry.error,
      };
      this.events.emit(EVENT_SYNC_CHANGED, payload);
    }
    return result;
  }

  private async snapshot(groupId: string): Promise<Map<string, StatusEntry>> {
    const map = new Map<string, StatusEntry>();
    const group = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        syncStatus: true,
        syncError: true,
        rules: { select: { id: true, name: true, syncStatus: true, syncError: true } },
      },
    });
    if (!group) return map;
    map.set(`group:${group.id}`, {
      groupId: group.id,
      ruleId: null,
      kind: 'group',
      name: group.name,
      status: group.syncStatus,
      error: group.syncError,
    });
    for (const rule of group.rules) {
      map.set(`rule:${rule.id}`, {
        groupId: group.id,
        ruleId: rule.id,
        kind: 'rule',
        name: rule.name,
        status: rule.syncStatus,
        error: rule.syncError,
      });
    }
    return map;
  }
}
