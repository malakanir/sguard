'use client';

import { io, type Socket } from 'socket.io-client';
import { API_URL } from '@/lib/api';

export interface RuleHighPayload {
  ruleId: string;
  groupId: string;
  name: string;
  riskReason: string | null;
}

export interface SyncChangedPayload {
  ruleId: string | null;
  groupId: string;
  kind: 'group' | 'rule';
  name: string;
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  error: string | null;
}

export interface DriftDetectedPayload {
  groupId: string;
  name: string;
  missingInCloud: number;
  extraInCloud: number;
  groupMissingInCloud: boolean;
}

/** Koneksi WebSocket ke /events. JWT dikirim saat handshake. Gagal diam-diam: realtime hanya tambahan. */
export function connectRealtime(
  token: string,
  handlers: {
    onRuleHigh: (p: RuleHighPayload) => void;
    onSyncChanged: (p: SyncChangedPayload) => void;
    onDriftDetected: (p: DriftDetectedPayload) => void;
  },
): Socket {
  const socket = io(`${API_URL}/events`, {
    auth: { token },
    transports: ['websocket'],
    reconnectionAttempts: 5,
  });
  socket.on('rule.high', handlers.onRuleHigh);
  socket.on('sync.changed', handlers.onSyncChanged);
  socket.on('drift.detected', handlers.onDriftDetected);
  return socket;
}
