'use client';

import { useEffect, useState } from 'react';
import { getToken } from '@/lib/api';
import { connectRealtime, type DriftDetectedPayload, type RuleHighPayload, type SyncChangedPayload } from '@/lib/realtime';

interface Toast {
  id: number;
  tone: 'danger' | 'info' | 'success';
  title: string;
  body: string;
}

/** Menyambung realtime dan menampilkan notifikasi (PRD bagian 10: toast). */
export function RealtimeToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let nextId = 1;
    const push = (toast: Omit<Toast, 'id'>) => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000);
    };

    const socket = connectRealtime(token, {
      onRuleHigh: (p: RuleHighPayload) =>
        push({ tone: 'danger', title: 'Rule HIGH dibuat', body: `${p.name}${p.riskReason ? ` · ${p.riskReason}` : ''}` }),
      onSyncChanged: (p: SyncChangedPayload) => {
        if (p.status === 'SYNCED' && p.kind === 'group') return; // sukses rutin tidak perlu toast
        push({
          tone: p.status === 'FAILED' ? 'danger' : 'info',
          title: `Sync ${p.kind === 'group' ? 'group' : 'rule'} ${p.status}`,
          body: `${p.name}${p.error ? ` · ${p.error}` : ''}`,
        });
      },
      onDriftDetected: (p: DriftDetectedPayload) =>
        push({
          tone: 'danger',
          title: 'Drift terdeteksi',
          body: p.groupMissingInCloud
            ? `${p.name}: group tidak ada lagi di cloud.`
            : `${p.name}: ${p.missingInCloud} rule hilang, ${p.extraInCloud} rule asing.`,
        }),
    });
    return () => {
      socket.close();
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg ${
            t.tone === 'danger'
              ? 'border-red-200 bg-red-50 text-red-900'
              : t.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-sky-200 bg-white text-slate-800'
          }`}
        >
          <p className="font-semibold">{t.title}</p>
          <p className="mt-0.5 break-words text-xs opacity-90">{t.body}</p>
        </div>
      ))}
    </div>
  );
}
