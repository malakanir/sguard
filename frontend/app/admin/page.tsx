'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Card, EmptyState, inputClass, Pagination, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { AdminSummary, AdminUser, Paginated } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';

export default function AdminPage() {
  return (
    <AppShell>
      <AdminContent />
    </AppShell>
  );
}

function AdminContent() {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [users, setUsers] = useState<Paginated<AdminUser> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api<AdminSummary>('/admin/summary')
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Ringkasan admin gagal dimuat.'));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: '10' });
    if (debounced) params.set('search', debounced);
    api<Paginated<AdminUser>>(`/admin/users?${params}`)
      .then(setUsers)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Daftar user gagal dimuat.'));
  }, [debounced, page]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-slate-500">Ringkasan agregat seluruh user. Isi rule milik user tidak ditampilkan.</p>
      </div>

      {error && <Alert>{error}</Alert>}

      {summary && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label="User" value={summary.totalUsers} />
          <Stat label="Group" value={summary.totalGroups} />
          <Stat label="Rule" value={summary.totalRules} />
          <Stat label="Rule HIGH" value={summary.rulesByRisk.HIGH ?? 0} tone="text-red-700" />
          <Stat label="Synced" value={summary.rulesBySyncStatus.SYNCED ?? 0} />
          <Stat label="Pending" value={summary.rulesBySyncStatus.PENDING ?? 0} />
          <Stat label="Failed" value={summary.rulesBySyncStatus.FAILED ?? 0} tone="text-rose-700" />
        </div>
      )}

      <Card>
        <div className="border-b border-slate-200 p-4">
          <input className={`${inputClass} sm:max-w-xs`} placeholder="Cari nama atau email…" value={search} onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }} aria-label="Cari user" />
        </div>
        {!users && !error && <Spinner />}
        {users && users.data.length === 0 && <EmptyState title="Tidak ada user yang cocok." />}
        {users && users.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Nama</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2 text-right">Group</th>
                  <th className="px-4 py-2 text-right">Rule</th>
                  <th className="px-4 py-2">Dibuat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-medium">{u.name}</td>
                    <td className="px-4 py-3 text-slate-600">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${u.role === 'ADMIN' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{u.groupCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{u.ruleCount}</td>
                    <td className="px-4 py-3 text-slate-500">{new Date(u.createdAt).toLocaleDateString('id-ID')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {users && users.meta.totalPages > 1 && (
          <Pagination page={users.meta.page} totalPages={users.meta.totalPages} onChange={setPage} />
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone = 'text-slate-900' }: { label: string; value: number; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </Card>
  );
}
