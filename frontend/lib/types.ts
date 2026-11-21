export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type SyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';
export type Protocol = 'tcp' | 'udp' | 'icmp';
export type Direction = 'INGRESS' | 'EGRESS';
export type GroupRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type ScanStatus = 'OK' | 'DRIFT' | 'NOT_SYNCED' | 'ERROR';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export interface Rule {
  id: string;
  securityGroupId: string;
  name: string;
  direction: Direction;
  protocol: Protocol;
  port: number | null;
  portTo: number | null;
  cidr: string;
  description: string | null;
  riskLevel: RiskLevel;
  riskReason: string | null;
  recommendation: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
  group?: { id: string; name: string; syncStatus: SyncStatus; flociGroupId?: string | null };
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  flociGroupId: string | null;
  awsAccountId: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  lastScanAt: string | null;
  lastScanStatus: ScanStatus | null;
  createdAt: string;
  updatedAt: string;
  ruleCount?: number;
  rules?: Rule[];
  riskSummary?: Record<RiskLevel, number>;
  /** Peran user yang sedang login terhadap group ini. */
  myRole?: GroupRole;
  owner?: { id: string; name: string };
  ownerName?: string;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface DashboardSummary {
  total: Record<RiskLevel | 'all', number>;
  perGroup: { groupId: string; name: string; HIGH: number; MEDIUM: number; LOW: number; total: number }[];
}

export interface SimulationResult {
  input: { sourceIp: string; protocol: Protocol; port: number | null; direction: Direction };
  decision: 'ALLOW' | 'DENY';
  matchedRules: { id: string; name: string; direction: Direction; protocol: Protocol; port: number | null; portTo: number | null; cidr: string }[];
}

export interface AuditEntry {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  ruleId: string | null;
  securityGroupId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface PresetInfo {
  id: 'web-server' | 'ssh-admin' | 'db-internal';
  name: string;
  description: string;
  rules: { name: string; protocol: Protocol; port: number; sourceCidr: string }[];
}

export interface DriftItem {
  id?: string;
  name?: string;
  direction: Direction;
  protocol: Protocol;
  port: number | null;
  portTo: number | null;
  cidr: string;
}

export interface DriftReport {
  status: 'NOT_SYNCED' | 'IN_SYNC' | 'DRIFT';
  missingInCloud: DriftItem[];
  extraInCloud: DriftItem[];
  unmanagedInCloud: number;
  groupMissingInCloud: boolean;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: GroupRole;
}

export interface AdminSummary {
  totalUsers: number;
  totalGroups: number;
  totalRules: number;
  rulesByRisk: Partial<Record<RiskLevel, number>>;
  rulesBySyncStatus: Partial<Record<SyncStatus, number>>;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  groupCount: number;
  ruleCount: number;
}

export interface AuthConfig {
  emailVerification: boolean;
  github: boolean;
}

export interface AwsAccount {
  id: string;
  name: string;
  region: string;
  accessKeyIdHint: string;
  groupCount: number;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  createdAt: string;
}

export type ChannelType = 'EMAIL' | 'SLACK' | 'WEBHOOK';
export type NotificationEvent = 'rule.high' | 'sync.failed' | 'drift.detected';

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  targetHint: string;
  hasSecret: boolean;
  events: NotificationEvent[];
  enabled: boolean;
  lastStatus: 'OK' | 'ERROR' | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
}
