'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Alert, buttonClass, Card, dangerButtonClass, ghostButtonClass, inputClass, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatRule } from '@/lib/rule-format';
import type { AuditEntry, DriftReport, GroupRole, Member, PresetInfo, ScanStatus } from '@/lib/types';

/* ---------- Drift (FR-18) ---------- */

export function DriftBanner({ groupId, reloadKey, onRepaired, canRepair }: { groupId: string; reloadKey: string; onRepaired: () => void; canRepair: boolean }) {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<DriftReport>(`/groups/${groupId}/drift`)
      .then((res) => {
        if (!cancelled) {
          setReport(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Pengecekan drift gagal.');
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, reloadKey]);

  async function repair() {
    setRepairing(true);
    setError(null);
    try {
      const res = await api<DriftReport>(`/groups/${groupId}/drift/repair`, { method: 'POST' });
      setReport(res);
      onRepaired();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Perbaikan gagal.');
    } finally {
      setRepairing(false);
    }
  }

  if (error) return <Alert>Drift: {error}</Alert>;
  if (!report) return null;
  if (report.status === 'IN_SYNC' || report.status === 'NOT_SYNCED') return null;

  return (
    <Alert>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Drift terdeteksi: isi database dan cloud berbeda.</p>
          {report.groupMissingInCloud && (
            <p className="mt-1 text-sm">Security Group tidak ada lagi di cloud. Perbaiki akan membuatnya ulang beserta semua rule.</p>
          )}
          <ul className="mt-1 list-disc pl-5 text-sm">
            {report.missingInCloud.map((r) => (
              <li key={`m-${r.id}`}>Hilang di cloud: {r.name ?? 'rule'} ({formatRule(r)})</li>
            ))}
            {report.extraInCloud.map((r, i) => (
              <li key={`e-${i}`}>Asing di cloud (akan dicabut): {formatRule(r)}</li>
            ))}
          </ul>
          {report.unmanagedInCloud > 0 && (
            <p className="mt-1 text-xs opacity-80">{report.unmanagedInCloud} rule di cloud di luar cakupan tidak diubah.</p>
          )}
        </div>
        {canRepair && (
          <button className={ghostButtonClass} onClick={repair} disabled={repairing}>
            {repairing ? 'Memperbaiki…' : 'Perbaiki'}
          </button>
        )}
      </div>
    </Alert>
  );
}

/* ---------- Scan terjadwal (FR-25) ---------- */

const SCAN_LABEL: Record<ScanStatus, string> = {
  OK: 'Sesuai',
  DRIFT: 'Drift',
  NOT_SYNCED: 'Belum tersinkron',
  ERROR: 'Gagal diperiksa',
};

export function ScanPanel({
  groupId,
  lastScanAt,
  lastScanStatus,
  onScanned,
}: {
  groupId: string;
  lastScanAt: string | null;
  lastScanStatus: ScanStatus | null;
  onScanned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/scan`, { method: 'POST' });
      onScanned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scan gagal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
      <span>
        Scan terakhir:{' '}
        {lastScanAt ? (
          <>
            <span className="font-medium text-slate-800">{lastScanStatus ? SCAN_LABEL[lastScanStatus] : '–'}</span> ·{' '}
            {new Date(lastScanAt).toLocaleString('id-ID')}
          </>
        ) : (
          'belum pernah'
        )}
      </span>
      <button className={ghostButtonClass} onClick={scan} disabled={busy}>
        {busy ? 'Memeriksa…' : 'Scan sekarang'}
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}

/* ---------- Member dan berbagi (FR-27) ---------- */

const ROLE_LABEL: Record<GroupRole, string> = { OWNER: 'Pemilik', EDITOR: 'Editor', VIEWER: 'Viewer' };

export function MembersPanel({ groupId, isOwner, onChanged }: { groupId: string; isOwner: boolean; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'VIEWER' | 'EDITOR'>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<Member[]>(`/groups/${groupId}/members`)
      .then((res) => {
        if (!cancelled) setMembers(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Daftar anggota gagal dimuat.');
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, version]);

  async function share(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) });
      setEmail('');
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal membagikan group.');
    }
  }

  async function remove(member: Member) {
    const self = !isOwner;
    if (!window.confirm(self ? 'Keluar dari group ini?' : `Hapus akses ${member.email}?`)) return;
    setError(null);
    try {
      await api<void>(`/groups/${groupId}/members/${member.userId}`, { method: 'DELETE' });
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menghapus akses.');
    }
  }

  return (
    <Card className="p-5">
      <h2 className="font-semibold">Anggota</h2>
      <p className="mb-3 text-sm text-slate-500">
        Viewer hanya membaca. Editor boleh mengubah rule dan sync. Hanya pemilik yang bisa membagikan atau menghapus group.
      </p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {!members && !error && <Spinner label="Memuat anggota…" />}
      {members && (
        <ul className="mb-4 divide-y divide-slate-100 text-sm">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{m.name}</span> <span className="text-slate-500">{m.email}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{ROLE_LABEL[m.role]}</span>
                {isOwner && m.role !== 'OWNER' && (
                  <button className={dangerButtonClass} onClick={() => remove(m)}>
                    Hapus
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <form onSubmit={share} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Email pengguna</span>
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="tim@contoh.com" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Peran</span>
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as 'VIEWER' | 'EDITOR')}>
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Editor</option>
            </select>
          </label>
          <button className={buttonClass}>Bagikan</button>
        </form>
      )}
    </Card>
  );
}

/* ---------- Preset (FR-14) ---------- */

export function PresetPanel({ groupId, onApplied }: { groupId: string; onApplied: (message: string) => void }) {
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [sourceCidr, setSourceCidr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PresetInfo[]>('/presets')
      .then(setPresets)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Preset gagal dimuat.'));
  }, []);

  async function apply(preset: PresetInfo) {
    setBusy(preset.id);
    setError(null);
    try {
      const body = { presetId: preset.id, ...(sourceCidr.trim() ? { sourceCidr: sourceCidr.trim() } : {}) };
      const res = await api<{ created: string[]; skipped: string[] }>(`/groups/${groupId}/presets`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onApplied(
        `Preset "${preset.name}": ${res.created.length} rule ditambahkan` +
          (res.skipped.length ? `, ${res.skipped.length} sudah ada.` : '.'),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Preset gagal diterapkan.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="font-semibold">Preset rule</h2>
      <p className="mb-3 text-sm text-slate-500">Buat paket rule sekali klik. Rule yang sudah ada dilewati.</p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <label className="mb-3 block text-sm">
        <span className="mb-1 block font-medium text-slate-700">CIDR sumber (opsional, mengganti default preset)</span>
        <input className={`${inputClass} font-mono`} value={sourceCidr} onChange={(e) => setSourceCidr(e.target.value)} placeholder="Misalnya 198.51.100.7/32" />
      </label>
      {!presets && !error && <Spinner label="Memuat preset…" />}
      <div className="grid gap-3 sm:grid-cols-3">
        {presets?.map((preset) => (
          <div key={preset.id} className="flex flex-col rounded-lg border border-slate-200 p-3">
            <p className="font-medium">{preset.name}</p>
            <p className="mb-2 flex-1 text-xs text-slate-500">{preset.description}</p>
            <ul className="mb-3 space-y-0.5 font-mono text-[11px] text-slate-600">
              {preset.rules.map((r) => (
                <li key={r.name}>
                  {r.protocol}/{r.port} · {sourceCidr.trim() || r.sourceCidr}
                </li>
              ))}
            </ul>
            <button className={buttonClass} onClick={() => apply(preset)} disabled={busy !== null}>
              {busy === preset.id ? 'Menerapkan…' : 'Terapkan'}
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Riwayat perubahan (FR-13) ---------- */

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  CREATE: 'Dibuat',
  UPDATE: 'Diubah',
  DELETE: 'Dihapus',
};

function describeSnapshot(snapshot: Record<string, unknown> | null): string {
  if (!snapshot) return '–';
  return `${snapshot.name} · ${formatRule({
    direction: snapshot.direction as 'INGRESS' | 'EGRESS' | undefined,
    protocol: snapshot.protocol as 'tcp' | 'udp' | 'icmp',
    port: (snapshot.port as number | null) ?? null,
    portTo: (snapshot.portTo as number | null) ?? null,
    cidr: String(snapshot.cidr),
  })} · ${snapshot.riskLevel}`;
}

export function HistoryPanel({ groupId, reloadKey }: { groupId: string; reloadKey: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ data: AuditEntry[] }>(`/audit?groupId=${groupId}&limit=50`)
      .then((res) => {
        if (!cancelled) setEntries(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Riwayat gagal dimuat.');
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, reloadKey]);

  return (
    <Card>
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Riwayat perubahan</div>
      {error && <div className="p-4"><Alert>{error}</Alert></div>}
      {!entries && !error && <Spinner label="Memuat riwayat…" />}
      {entries && entries.length === 0 && <p className="p-4 text-sm text-slate-500">Belum ada perubahan tercatat.</p>}
      {entries && entries.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {entries.map((e) => (
            <li key={e.id} className="space-y-1 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{ACTION_LABEL[e.action]}</span>
                <span className="text-xs text-slate-500">{new Date(e.createdAt).toLocaleString('id-ID')}</span>
              </div>
              {e.action === 'UPDATE' ? (
                <div className="font-mono text-xs text-slate-700">
                  <p>Sebelum: {describeSnapshot(e.before)}</p>
                  <p>Sesudah: {describeSnapshot(e.after)}</p>
                </div>
              ) : (
                <p className="font-mono text-xs text-slate-700">{describeSnapshot(e.action === 'DELETE' ? e.before : e.after)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
