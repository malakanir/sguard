/** Nama event internal (EventEmitter) dan event realtime (WebSocket). PRD bagian 9. */
export const EVENT_RULE_HIGH = 'rule.high';
export const EVENT_SYNC_CHANGED = 'sync.changed';
export const EVENT_DRIFT_DETECTED = 'drift.detected';

/** Informasi dasar setiap event group: pemilik dan semua user yang boleh melihatnya. */
export interface GroupEventBase {
  ownerId: string;
  audience: string[];
  groupId: string;
}

export interface RuleHighEvent extends GroupEventBase {
  ruleId: string;
  name: string;
  riskReason: string | null;
}

export interface SyncChangedEvent extends GroupEventBase {
  ruleId: string | null;
  kind: 'group' | 'rule';
  name: string;
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  error: string | null;
}

export interface DriftDetectedEvent extends GroupEventBase {
  name: string;
  missingInCloud: number;
  extraInCloud: number;
  groupMissingInCloud: boolean;
}
