import { RuleSpec } from '../risk/risk';
import type { DriftReport } from './sync.service';

export interface GroupRef {
  flociGroupId: string | null;
  awsAccountId?: string | null;
}

/**
 * Kontrak sinkronisasi ke cloud. Dua implementasi:
 * - SyncService: langsung di proses API (SYNC_TRANSPORT=local)
 * - RemoteSyncPort: lewat TCP ke sync-worker (SYNC_TRANSPORT=tcp)
 */
export interface SyncPort {
  ensureGroup(groupId: string): Promise<void>;
  pushRule(ruleId: string, previous?: RuleSpec): Promise<void>;
  removeRule(rule: RuleSpec, group: GroupRef): Promise<void>;
  removeGroup(group: GroupRef): Promise<void>;
  inspect(groupId: string): Promise<DriftReport>;
  repair(groupId: string): Promise<DriftReport>;
}

/** Token untuk port yang dipakai service lain (sudah dibungkus SyncFacade). */
export const SYNC_PORT = Symbol('SYNC_PORT');
/** Token untuk backend sebenarnya: SyncService atau RemoteSyncPort. */
export const SYNC_BACKEND = Symbol('SYNC_BACKEND');

/** Pola pesan TCP antara API dan sync-worker. */
export const SYNC_PATTERNS = {
  ensureGroup: 'sync.ensureGroup',
  pushRule: 'sync.pushRule',
  removeRule: 'sync.removeRule',
  removeGroup: 'sync.removeGroup',
  inspect: 'sync.inspect',
  repair: 'sync.repair',
} as const;
