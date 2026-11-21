'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Card, EmptyState, ghostButtonClass, inputClass, Pagination, RiskBadge, SyncBadge, Spinner } from '@/components/ui';
import { api, ApiError, download } from '@/lib/api';
import type { DashboardSummary, Group, Paginated, RiskLevel, Rule } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardContent />
    </AppShell>
  );
}

function DashboardContent() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [rules, setRules] = useState<Paginated<Rule> | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [risk, setRisk] = useState<RiskLevel | ''>('');
  const [groupId, setGroupId] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function runExport(format: 'csv' | 'json') {
    setExporting(format);
    setExportError(null);
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      await download(`/reports/export?format=${format}`, `sguard-rules-${date}.${format}`);
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Ekspor gagal.');
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    api<DashboardSummary>('/dashboard/summary')
      .then(setSummary)
      .catch((err) => setSummaryError(err instanceof ApiError ? err.message : 'Ringkasan gagal dimuat.'));
    api<Paginated<Group>>('/groups?limit=50')
      .then((res) => setGroups(res.data))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (risk) params.set('risk', risk);
    if (groupId) params.set('groupId', groupId);
    api<Paginated<Rule>>(`/rules?${params}`)
      .then((res) => {
        setRules(res);
        setRulesError(null);
      })
      .catch((err) => setRulesError(err instanceof ApiError ? err.message : 'Daftar rule gagal dimuat.'));
  }, [debouncedSearch, risk, groupId, page]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-sm text-slate-500">Ringkasan risiko seluruh rule Anda.</p>
          </div>
          <div className="flex gap-2">
            <button className={ghostButtonClass} onClick={() => runExport('csv')} disabled={exporting !== null}>
              {exporting === 'csv' ? 'Mengunduh…' : 'Ekspor CSV'}
            </button>
            <button className={ghostButtonClass} onClick={() => runExport('json')} disabled={exporting !== null}>
              {exporting === 'json' ? 'Mengunduh…' : 'Ekspor JSON'}
            </button>
          </div>
        </div>
        {exportError && <Alert>{exportError}</Alert>}
      </div>

      {summaryError && <Alert>{summaryError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-3">
        {(['HIGH', 'MEDIUM', 'LOW'] as RiskLevel[]).map((level) => (
          <button
            key={level}
            onClick={() => {
              setRisk(risk === level ? '' : level);
              setPage(1);
            }}
            className={`text-left ${risk === level ? 'ring-2 ring-indigo-500 rounded-xl' : ''}`}
          >
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <RiskBadge level={level} />
                <span className="text-xs text-slate-500">{risk === level ? 'Filter aktif' : 'Klik untuk filter'}</span>
              </div>
              <p className="mt-3 text-3xl font-semibold tabular-nums">{summary?.total[level] ?? '–'}</p>
              <p className="text-sm text-slate-500">rule {level.toLowerCase()} risiko</p>
            </Card>
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center">
          <input
            className={`${inputClass} sm:max-w-xs`}
            placeholder="Cari nama, CIDR, atau deskripsi…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Cari rule"
          />
          <select className={`${inputClass} sm:w-48`} value={risk} onChange={(e) => {
              setRisk(e.target.value as RiskLevel | '');
              setPage(1);
            }} aria-label="Filter risiko">
            <option value="">Semua risiko</option>
            <option value="HIGH">HIGH</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
          </select>
          <select className={`${inputClass} sm:w-56`} value={groupId} onChange={(e) => {
              setGroupId(e.target.value);
              setPage(1);
            }} aria-label="Filter group">
            <option value="">Semua group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        {rulesError && <div className="p-4"><Alert>{rulesError}</Alert></div>}
        {!rules && !rulesError && <Spinner />}
        {rules && rules.data.length === 0 && (
          <EmptyState
            title="Belum ada rule yang cocok."
            hint={risk || groupId || debouncedSearch ? 'Coba ubah atau hapus filter.' : 'Buat security group lalu tambahkan rule pertama Anda.'}
          />
        )}
        {rules && rules.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Rule</th>
                  <th className="px-4 py-2">Group</th>
                  <th className="px-4 py-2">Protocol / Port</th>
                  <th className="px-4 py-2">CIDR</th>
                  <th className="px-4 py-2">Risiko</th>
                  <th className="px-4 py-2">Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.data.map((rule) => (
                  <tr key={rule.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/groups/${rule.securityGroupId}?rule=${rule.id}`} className="font-medium text-indigo-700 hover:underline">
                        {rule.name}
                      </Link>
                      {rule.riskReason && rule.riskLevel !== 'LOW' && (
                        <p className="mt-0.5 text-xs text-slate-500">{rule.riskReason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{rule.group?.name ?? '–'}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {rule.protocol}
                      {rule.port !== null ? ` / ${rule.port}` : ''}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{rule.cidr}</td>
                    <td className="px-4 py-3"><RiskBadge level={rule.riskLevel} /></td>
                    <td className="px-4 py-3"><SyncBadge status={rule.syncStatus} error={rule.syncError} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rules && rules.meta.totalPages > 1 && (
          <Pagination page={rules.meta.page} totalPages={rules.meta.totalPages} onChange={setPage} />
        )}
      </Card>

      {summary && summary.perGroup.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Per group</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {summary.perGroup.map((g) => (
              <li key={g.groupId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/groups/${g.groupId}`} className="font-medium text-indigo-700 hover:underline">
                  {g.name}
                </Link>
                <span className="flex gap-2 text-xs">
                  <span className="rounded bg-red-50 px-2 py-0.5 text-red-700">HIGH {g.HIGH}</span>
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">MEDIUM {g.MEDIUM}</span>
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">LOW {g.LOW}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
