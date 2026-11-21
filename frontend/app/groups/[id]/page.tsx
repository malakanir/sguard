'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  Alert,
  buttonClass,
  Card,
  dangerButtonClass,
  EmptyState,
  ghostButtonClass,
  inputClass,
  RiskBadge,
  Spinner,
  SyncBadge,
} from '@/components/ui';
import { DriftBanner, HistoryPanel, MembersPanel, PresetPanel, ScanPanel } from '@/components/group-extras';
import { api, ApiError } from '@/lib/api';
import { formatRule } from '@/lib/rule-format';
import { previewRisk } from '@/lib/risk-preview';
import type { Direction, Group, Protocol, Rule, SimulationResult } from '@/lib/types';

export default function GroupDetailPage() {
  return (
    <AppShell>
      <GroupDetail />
    </AppShell>
  );
}

function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  // Berubah setiap ada aksi, supaya drift, riwayat, dan scan ikut dimuat ulang.
  const reloadKey = `${formVersion}|${notice ?? ''}|${group?.updatedAt ?? ''}|${group?.rules?.length ?? 0}|${reloadTick}`;

  useEffect(() => {
    let cancelled = false;
    api<Group>(`/groups/${id}`)
      .then((g) => {
        if (!cancelled) {
          setGroup(g);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Group gagal dimuat.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadTick]);

  async function retrySync() {
    setNotice(null);
    try {
      const updated = await api<Group>(`/groups/${id}/sync`, { method: 'POST' });
      setGroup(updated);
      setNotice(`Sync: ${updated.syncStatus}${updated.syncError ? ` (${updated.syncError})` : ''}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sync ulang gagal.');
    }
  }

  async function deleteRule(rule: Rule) {
    if (!window.confirm(`Hapus rule "${rule.name}"? Rule juga dicabut dari cloud.`)) return;
    try {
      await api<void>(`/rules/${rule.id}`, { method: 'DELETE' });
      if (editingRule?.id === rule.id) setEditingRule(null);
      setNotice(`Rule "${rule.name}" dihapus.`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rule gagal dihapus.');
    }
  }

  if (error && !group) {
    return (
      <div className="space-y-4">
        <Alert>{error}</Alert>
        <Link href="/groups" className="text-sm text-indigo-600 hover:underline">
          ← Kembali ke daftar group
        </Link>
      </div>
    );
  }
  if (!group) return <Spinner />;

  const rules = group.rules ?? [];
  const summary = group.riskSummary ?? { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const role = group.myRole ?? 'VIEWER';
  const canEdit = role === 'OWNER' || role === 'EDITOR';
  const isOwner = role === 'OWNER';

  return (
    <div className="space-y-6">
      <div>
        <Link href="/groups" className="text-sm text-indigo-600 hover:underline">
          ← Semua group
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{group.name}</h1>
            {group.description && <p className="text-sm text-slate-500">{group.description}</p>}
            {!isOwner && group.owner && (
              <p className="text-xs text-slate-500">Dibagikan oleh {group.owner.name}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SyncBadge status={group.syncStatus} error={group.syncError} />
            {canEdit && group.syncStatus !== 'SYNCED' && (
              <button className={ghostButtonClass} onClick={retrySync}>
                Sync ulang
              </button>
            )}
          </div>
        </div>
      </div>

      {!canEdit && <Alert kind="info">Anda hanya dapat melihat group ini (peran Viewer). Perubahan dinonaktifkan.</Alert>}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}
      <DriftBanner groupId={group.id} reloadKey={reloadKey} canRepair={canEdit} onRepaired={() => { setNotice('Drift diperbaiki lewat sync ulang.'); load(); }} />
      {group.syncError && group.syncStatus === 'FAILED' && (
        <Alert>
          Sinkronisasi ke cloud gagal. Data tetap tersimpan di database; coba lagi setelah cloud tersedia.
          <span className="mt-1 block font-mono text-xs opacity-80">{group.syncError}</span>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScanPanel groupId={group.id} lastScanAt={group.lastScanAt} lastScanStatus={group.lastScanStatus} onScanned={load} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(['HIGH', 'MEDIUM', 'LOW'] as const).map((level) => (
          <Card key={level} className="flex items-center justify-between p-4">
            <RiskBadge level={level} />
            <span className="text-2xl font-semibold tabular-nums">{summary[level]}</span>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Rule ({rules.length})</div>
            {rules.length === 0 ? (
              <EmptyState title="Belum ada rule di group ini." hint={canEdit ? 'Tambahkan rule lewat form di bawah.' : undefined} />
            ) : (
              <ul className="divide-y divide-slate-100">
                {rules.map((rule) => (
                  <li key={rule.id} className={`space-y-2 p-4 ${editingRule?.id === rule.id ? 'bg-indigo-50/60' : ''}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <RiskBadge level={rule.riskLevel} />
                        <span className="font-medium">{rule.name}</span>
                        <span className="font-mono text-xs text-slate-600">{formatRule(rule)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <SyncBadge status={rule.syncStatus} error={rule.syncError} />
                        {canEdit && (
                          <>
                            <button className={ghostButtonClass} onClick={() => setEditingRule(rule)}>
                              Ubah
                            </button>
                            <button className={dangerButtonClass} onClick={() => deleteRule(rule)}>
                              Hapus
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {rule.riskLevel !== 'LOW' && rule.riskReason && (
                      <p className="text-sm text-slate-700">
                        {rule.riskReason}
                        {rule.recommendation && <span className="block text-slate-500">Saran: {rule.recommendation}</span>}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {canEdit && (
            <PresetPanel
              groupId={group.id}
              onApplied={(message) => {
                setNotice(message);
                load();
              }}
            />
          )}

          <HistoryPanel groupId={group.id} reloadKey={reloadKey} />

          <MembersPanel groupId={group.id} isOwner={isOwner} onChanged={load} />

          {canEdit && (
            <RuleForm
              key={`${editingRule?.id ?? 'new'}-${formVersion}`}
              groupId={group.id}
              rule={editingRule}
              onCancel={() => setEditingRule(null)}
              onSaved={(message) => {
                setEditingRule(null);
                setFormVersion((v) => v + 1);
                setNotice(message);
                load();
              }}
            />
          )}
        </div>

        <Simulator groupId={group.id} />
      </div>
    </div>
  );
}

function RuleForm({
  groupId,
  rule,
  onCancel,
  onSaved,
}: {
  groupId: string;
  rule: Rule | null;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [direction, setDirection] = useState<Direction>(rule?.direction ?? 'INGRESS');
  const [protocol, setProtocol] = useState<Protocol>(rule?.protocol ?? 'tcp');
  const [port, setPort] = useState(rule?.port !== null && rule?.port !== undefined ? String(rule.port) : '');
  const [portTo, setPortTo] = useState(rule?.portTo !== null && rule?.portTo !== undefined ? String(rule.portTo) : '');
  const [cidr, setCidr] = useState(rule?.cidr ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isIcmp = protocol === 'icmp';
  const portNumber = isIcmp || port === '' ? null : Number(port);
  const portToNumber = isIcmp || portTo === '' ? null : Number(portTo);
  // Pratinjau hanya bantuan tampilan; nilai tersimpan dihitung backend.
  const preview = useMemo(
    () => (cidr ? previewRisk(direction, protocol, portNumber, portToNumber, cidr) : null),
    [direction, protocol, portNumber, portToNumber, cidr],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body = {
      name,
      direction,
      protocol,
      port: portNumber,
      portTo: portToNumber,
      cidr,
      description: description || undefined,
    };
    try {
      if (rule) {
        await api(`/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        onSaved(`Rule "${name}" diperbarui.`);
      } else {
        await api(`/groups/${groupId}/rules`, { method: 'POST', body: JSON.stringify(body) });
        onSaved(`Rule "${name}" ditambahkan.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rule gagal disimpan.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">{rule ? `Ubah rule: ${rule.name}` : 'Tambah rule'}</h2>
        {rule && (
          <button className={ghostButtonClass} onClick={onCancel}>
            Batal ubah
          </button>
        )}
      </div>
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-700">Nama rule</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="SSH admin" required maxLength={100} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Arah</span>
          <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="INGRESS">Masuk (ingress)</option>
            <option value="EGRESS">Keluar (egress)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Protocol</span>
          <select className={inputClass} value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Port {isIcmp ? '' : 'awal'}</span>
          <input
            className={inputClass}
            inputMode="numeric"
            value={isIcmp ? '' : port}
            disabled={isIcmp}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder={isIcmp ? 'Tidak dipakai untuk ICMP' : '1-65535'}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Port akhir (rentang, opsional)</span>
          <input
            className={inputClass}
            inputMode="numeric"
            value={isIcmp ? '' : portTo}
            disabled={isIcmp}
            onChange={(e) => setPortTo(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="Kosongkan untuk satu port"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-700">CIDR sumber (IPv4 atau IPv6)</span>
          <input
            className={`${inputClass} font-mono`}
            value={cidr}
            onChange={(e) => setCidr(e.target.value.trim())}
            placeholder="0.0.0.0/0, 10.0.0.5/32, atau ::/0"
            required
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-700">Deskripsi (opsional)</span>
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>

        <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          {preview ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-slate-600">Pratinjau risiko:</span>
                <RiskBadge level={preview.level} />
              </div>
              <p className="mt-1 text-slate-700">{preview.reason}</p>
              {preview.recommendation && <p className="text-slate-500">Saran: {preview.recommendation}</p>}
            </>
          ) : (
            <p className="text-slate-500">Isi CIDR untuk melihat pratinjau risiko.</p>
          )}
        </div>

        <div className="sm:col-span-2 flex justify-end">
          <button className={buttonClass} disabled={saving}>
            {saving ? 'Menyimpan…' : rule ? 'Simpan perubahan' : 'Tambah rule'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function Simulator({ groupId }: { groupId: string }) {
  const [sourceIp, setSourceIp] = useState('8.8.8.8');
  const [direction, setDirection] = useState<Direction>('INGRESS');
  const [protocol, setProtocol] = useState<Protocol>('tcp');
  const [port, setPort] = useState('22');
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function onRun(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setRunning(true);
    try {
      const res = await api<SimulationResult>(`/groups/${groupId}/simulate`, {
        method: 'POST',
        body: JSON.stringify({
          sourceIp,
          protocol,
          direction,
          ...(protocol === 'icmp' ? {} : { port: Number(port) }),
        }),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Simulasi gagal.');
    } finally {
      setRunning(false);
    }
  }

  const allowed = result?.decision === 'ALLOW';
  const portLabel = result && result.input.port !== null ? `/${result.input.port}` : '';

  return (
    <Card className="h-fit p-5">
      <h2 className="font-semibold">Simulator akses</h2>
      <p className="mb-4 text-sm text-slate-500">Apakah IP tertentu boleh mengakses port ini di group ini?</p>
      <form onSubmit={onRun} className="space-y-3" noValidate>
        {error && <Alert>{error}</Alert>}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">IP sumber (IPv4 atau IPv6)</span>
          <input className={`${inputClass} font-mono`} value={sourceIp} onChange={(e) => setSourceIp(e.target.value.trim())} required />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Arah</span>
            <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="INGRESS">Masuk</option>
              <option value="EGRESS">Keluar</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Protocol</span>
            <select className={inputClass} value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="icmp">ICMP</option>
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Port</span>
          <input className={inputClass} inputMode="numeric" value={protocol === 'icmp' ? '' : port} disabled={protocol === 'icmp'} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
        </label>
        <button className={`${buttonClass} w-full`} disabled={running}>
          {running ? 'Menguji…' : 'Uji akses'}
        </button>
      </form>

      {result && (
        <div className="mt-5 space-y-3">
          <div
            className={`rounded-lg px-4 py-3 text-center text-lg font-bold ring-1 ring-inset ${
              allowed ? 'bg-emerald-50 text-emerald-800 ring-emerald-300' : 'bg-red-50 text-red-800 ring-red-300'
            }`}
          >
            {allowed ? '✓ ALLOW' : '✕ DENY'}
          </div>
          <p className="text-sm text-slate-600">
            {allowed
              ? `${result.input.sourceIp} boleh mengakses ${result.input.protocol}${portLabel}.`
              : `Tidak ada rule yang mengizinkan ${result.input.sourceIp} ke ${result.input.protocol}${portLabel}. Default: tolak.`}
          </p>
          {result.matchedRules.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Rule yang cocok</p>
              <ul className="space-y-1 text-sm">
                {result.matchedRules.map((r) => (
                  <li key={r.id} className="rounded-md bg-slate-50 px-3 py-2 font-mono text-xs">
                    {r.name} · {formatRule(r)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
