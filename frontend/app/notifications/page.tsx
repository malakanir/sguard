'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, buttonClass, Card, dangerButtonClass, EmptyState, ghostButtonClass, inputClass, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { ChannelType, NotificationChannel, NotificationEvent } from '@/lib/types';

export default function NotificationsPage() {
  return (
    <AppShell>
      <NotificationsContent />
    </AppShell>
  );
}

const EVENT_LABEL: Record<NotificationEvent, string> = {
  'rule.high': 'Rule HIGH dibuat',
  'sync.failed': 'Sync gagal',
  'drift.detected': 'Drift terdeteksi',
};

const TARGET_HINT: Record<ChannelType, { label: string; placeholder: string }> = {
  EMAIL: { label: 'Alamat email', placeholder: 'anda@contoh.com' },
  SLACK: { label: 'URL Slack webhook', placeholder: 'https://hooks.slack.com/services/…' },
  WEBHOOK: { label: 'URL webhook (https)', placeholder: 'https://contoh.com/hook' },
};

function NotificationsContent() {
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [type, setType] = useState<ChannelType>('EMAIL');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<NotificationEvent[]>(['rule.high']);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<NotificationChannel[]>('/notifications/channels')
      .then((res) => {
        if (!cancelled) {
          setChannels(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Daftar channel gagal dimuat.');
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  function toggleEvent(event: NotificationEvent) {
    setEvents((list) => (list.includes(event) ? list.filter((e) => e !== event) : [...list, event]));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api<NotificationChannel>('/notifications/channels', {
        method: 'POST',
        body: JSON.stringify({ type, target, events, ...(type === 'WEBHOOK' && secret ? { secret } : {}) }),
      });
      setTarget('');
      setSecret('');
      setNotice('Channel disimpan.');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Channel gagal disimpan.');
    } finally {
      setSaving(false);
    }
  }

  async function onTest(channel: NotificationChannel) {
    setBusyId(channel.id);
    setNotice(null);
    try {
      const updated = await api<NotificationChannel>(`/notifications/channels/${channel.id}/test`, { method: 'POST' });
      setNotice(updated.lastStatus === 'OK' ? 'Pesan uji terkirim.' : `Pesan uji gagal: ${updated.lastError ?? 'tidak diketahui'}`);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Tes gagal.');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(channel: NotificationChannel) {
    if (!window.confirm('Hapus channel ini?')) return;
    setBusyId(channel.id);
    try {
      await api<void>(`/notifications/channels/${channel.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Channel gagal dihapus.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifikasi</h1>
        <p className="text-sm text-slate-500">Kirim peringatan ke email, Slack, atau webhook saat ada kejadian penting.</p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Tambah channel</h2>
        <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Jenis</span>
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
              <option value="EMAIL">Email</option>
              <option value="SLACK">Slack</option>
              <option value="WEBHOOK">Webhook</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">{TARGET_HINT[type].label}</span>
            <input className={`${inputClass} font-mono`} value={target} onChange={(e) => setTarget(e.target.value.trim())} required placeholder={TARGET_HINT[type].placeholder} />
          </label>
          {type === 'WEBHOOK' && (
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block font-medium text-slate-700">Secret penandatanganan (opsional)</span>
              <input className={`${inputClass} font-mono`} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} maxLength={256} />
              <span className="mt-1 block text-xs text-slate-500">
                Dengan secret, setiap pengiriman membawa webhook-signature (Standard Webhooks, HMAC-SHA256).
              </span>
            </label>
          )}
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-slate-700">Kirim saat</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(Object.keys(EVENT_LABEL) as NotificationEvent[]).map((ev) => (
                <label key={ev} className="flex items-center gap-2">
                  <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
                  {EVENT_LABEL[ev]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2 flex justify-end">
            <button className={buttonClass} disabled={saving || events.length === 0}>
              {saving ? 'Menyimpan…' : 'Simpan channel'}
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Channel Anda</div>
        {!channels && !error && <Spinner />}
        {channels && channels.length === 0 && <EmptyState title="Belum ada channel." />}
        {channels && channels.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {channels.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {c.type} <span className="font-mono font-normal text-slate-500">{c.targetHint}</span>
                    {c.hasSecret && <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs">bertanda tangan</span>}
                  </p>
                  <p className="text-xs text-slate-500">{c.events.map((ev) => EVENT_LABEL[ev]).join(' · ')}</p>
                  {c.lastStatus && (
                    <p className={`text-xs ${c.lastStatus === 'OK' ? 'text-emerald-700' : 'text-red-700'}`}>
                      Pengiriman terakhir: {c.lastStatus}
                      {c.lastError ? ` · ${c.lastError}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button className={ghostButtonClass} onClick={() => onTest(c)} disabled={busyId === c.id}>
                    {busyId === c.id ? 'Mengirim…' : 'Tes'}
                  </button>
                  <button className={dangerButtonClass} onClick={() => onDelete(c)} disabled={busyId === c.id}>
                    Hapus
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
