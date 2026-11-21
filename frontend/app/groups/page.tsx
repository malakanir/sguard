'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, buttonClass, Card, dangerButtonClass, EmptyState, ghostButtonClass, inputClass, Pagination, Spinner, SyncBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { AwsAccount, Group, Paginated } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';

export default function GroupsPage() {
  return (
    <AppShell>
      <GroupsContent />
    </AppShell>
  );
}

const ROLE_BADGE: Record<string, string> = {
  OWNER: 'Pemilik',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

function GroupsContent() {
  const [result, setResult] = useState<Paginated<Group> | null>(null);
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [awsAccountId, setAwsAccountId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<AwsAccount[]>('/aws-accounts')
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '10' });
    if (debouncedSearch) params.set('search', debouncedSearch);
    api<Paginated<Group>>(`/groups?${params}`)
      .then((res) => {
        setResult(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Daftar group gagal dimuat.'));
  }, [debouncedSearch, page, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api<Group>('/groups', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || undefined,
          awsAccountId: awsAccountId || undefined,
        }),
      });
      setName('');
      setDescription('');
      setAwsAccountId('');
      setNotice(
        created.syncStatus === 'SYNCED'
          ? `Group "${created.name}" dibuat dan tersinkron.`
          : `Group "${created.name}" disimpan, tetapi sync gagal: ${created.syncError ?? 'tidak diketahui'}.`,
      );
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Group gagal dibuat.');
    } finally {
      setCreating(false);
    }
  }

  async function onRetry(group: Group) {
    setBusyId(group.id);
    setNotice(null);
    try {
      const updated = await api<Group>(`/groups/${group.id}/sync`, { method: 'POST' });
      setNotice(`Sync "${updated.name}": ${updated.syncStatus}.`);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sync ulang gagal.');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(group: Group) {
    const ok = window.confirm(
      `Hapus group "${group.name}" beserta semua rule-nya? Tindakan ini juga menghapus Security Group di cloud dan tidak bisa dibatalkan.`,
    );
    if (!ok) return;
    setBusyId(group.id);
    try {
      await api<void>(`/groups/${group.id}`, { method: 'DELETE' });
      setNotice(`Group "${group.name}" dihapus.`);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Group gagal dihapus.');
    } finally {
      setBusyId(null);
    }
  }

  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name ?? 'Akun AWS' : null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Security Groups</h1>
        <p className="text-sm text-slate-500">Kelompok rule, misalnya web-server atau database. Group yang dibagikan kepada Anda juga muncul di sini.</p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <Card className="p-5">
        <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Nama group</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="web-server" required maxLength={80} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Deskripsi (opsional)</span>
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Akun AWS</span>
            <select className={inputClass} value={awsAccountId} onChange={(e) => setAwsAccountId(e.target.value)}>
              <option value="">Floci / lokal</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.region})
                </option>
              ))}
            </select>
          </label>
          <button className={buttonClass} disabled={creating}>
            {creating ? 'Membuat…' : 'Buat group'}
          </button>
        </form>
      </Card>

      <Card>
        <div className="border-b border-slate-200 p-4">
          <input
            className={`${inputClass} sm:max-w-xs`}
            placeholder="Cari nama group…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Cari group"
          />
        </div>
        {!result && !error && <Spinner />}
        {result && result.data.length === 0 && (
          <EmptyState title={debouncedSearch ? 'Tidak ada group yang cocok.' : 'Belum ada group.'} hint="Buat group pertama di atas." />
        )}
        {result && result.data.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {result.data.map((group) => {
              const shared = group.myRole && group.myRole !== 'OWNER';
              return (
                <li key={group.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/groups/${group.id}`} className="font-medium text-indigo-700 hover:underline">
                        {group.name}
                      </Link>
                      {group.myRole && (
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${shared ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                          {ROLE_BADGE[group.myRole]}
                        </span>
                      )}
                      {accountName(group.awsAccountId) && (
                        <span className="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-800">AWS: {accountName(group.awsAccountId)}</span>
                      )}
                    </div>
                    {group.description && <p className="truncate text-sm text-slate-500">{group.description}</p>}
                    <p className="mt-1 text-xs text-slate-500">
                      {group.ruleCount ?? 0} rule
                      {shared && group.ownerName ? ` · milik ${group.ownerName}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SyncBadge status={group.syncStatus} error={group.syncError} />
                    {!shared && group.syncStatus === 'FAILED' && (
                      <button className={ghostButtonClass} disabled={busyId === group.id} onClick={() => onRetry(group)}>
                        Coba sync lagi
                      </button>
                    )}
                    <Link href={`/groups/${group.id}`} className={ghostButtonClass}>
                      Buka
                    </Link>
                    {!shared && (
                      <button className={dangerButtonClass} disabled={busyId === group.id} onClick={() => onDelete(group)}>
                        Hapus
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {result && result.meta.totalPages > 1 && (
          <Pagination page={result.meta.page} totalPages={result.meta.totalPages} onChange={setPage} />
        )}
      </Card>
    </div>
  );
}
