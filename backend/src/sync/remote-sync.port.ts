import { ClientProxy } from '@nestjs/microservices';
import { ServiceUnavailableException } from '@nestjs/common';
import { firstValueFrom, timeout } from 'rxjs';
import { RuleSpec } from '../risk/risk';
import { DriftReport } from './sync.service';
import { GroupRef, SYNC_PATTERNS, SyncPort } from './sync-port';

const CALL_TIMEOUT_MS = 20_000;

/** Meneruskan setiap panggilan sinkronisasi ke sync-worker lewat TCP. */
export class RemoteSyncPort implements SyncPort {
  constructor(private readonly client: ClientProxy) {}

  private call<T>(pattern: string, payload: unknown): Promise<T> {
    return firstValueFrom(this.client.send<T>(pattern, payload).pipe(timeout(CALL_TIMEOUT_MS)));
  }

  async ensureGroup(groupId: string): Promise<void> {
    await this.call(SYNC_PATTERNS.ensureGroup, { groupId });
  }

  async pushRule(ruleId: string, previous?: RuleSpec): Promise<void> {
    await this.call(SYNC_PATTERNS.pushRule, { ruleId, previous });
  }

  async removeRule(rule: RuleSpec, group: GroupRef): Promise<void> {
    await this.call(SYNC_PATTERNS.removeRule, { rule, group });
  }

  async removeGroup(group: GroupRef): Promise<void> {
    await this.call(SYNC_PATTERNS.removeGroup, { group });
  }

  async inspect(groupId: string): Promise<DriftReport> {
    return this.wrapUnavailable(this.call<DriftReport>(SYNC_PATTERNS.inspect, { groupId }));
  }

  async repair(groupId: string): Promise<DriftReport> {
    return this.wrapUnavailable(this.call<DriftReport>(SYNC_PATTERNS.repair, { groupId }));
  }

  private async wrapUnavailable<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      const message = (err as { message?: string })?.message ?? 'sync-worker tidak terjangkau';
      throw new ServiceUnavailableException(message);
    }
  }
}
