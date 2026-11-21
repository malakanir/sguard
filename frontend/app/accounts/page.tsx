'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, buttonClass, Card, dangerButtonClass, EmptyState, ghostButtonClass, inputClass, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { AwsAccount } from '@/lib/types';

export default function AccountsPage() {
  return (
    <AppShell>
      <AccountsContent />
    </AppShell>
  );
}

const REGIONS = [
  'us-east-1',
  'us-west-2',
  'ap-southeast-1',
  'ap-southeast-3',
  'ap-northeast-1',
  'eu-central-1',
  'eu-west-1',
];

function AccountsContent() {
  const [accounts, setAccounts] = useState<AwsAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [name, setName] = useState('');
  const [region, setRegion] = useState(REGIONS[0]);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<AwsAccount[]>('/aws-accounts')
      .then((res) => {
        if (!cancelled) {
          setAccounts(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Daftar akun gagal dimuat.');
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api<AwsAccount>('/aws-accounts', {
        method: 'POST',
        body: JSON.stringify({ name, region, accessKeyId, secretAccessKey }),
      });
      setName('');
      setAccessKeyId('');
      setSecretAccessKey('');
      setNotice('Akun AWS disimpan. Kredensial dienkripsi di server dan tidak ditampilkan lagi.');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Akun gagal disimpan.');
    } finally {
      setSaving(false);
    }
  }

  async function onTest(account: AwsAccount) {
    setBusyId(account.id);
    setNotice(null);
    try {
      const updated = await api<AwsAccount>(`/aws-accounts/${account.id}/test`, { method: 'POST' });
      setNotice(updated.lastVerifiedAt ? `Koneksi "${updated.name}" berhasil.` : `Koneksi "${updated.name}" gagal: ${updated.lastVerifyError}`);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Uji koneksi gagal.');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(account: AwsAccount) {
    if (!window.confirm(`Hapus akun "${account.name}"? Kredensial akan dihapus permanen.`)) return;
    setBusyId(account.id);
    setError(null);
    try {
      await api<void>(`/aws-accounts/${account.id}`, { method: 'DELETE' });
      setNotice(`Akun "${account.name}" dihapus.`);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Akun gagal dihapus.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Akun AWS</h1>
        <p className="text-sm text-slate-500">
          Hubungkan akun AWS untuk sinkronisasi ke cloud sungguhan. Satu akun per region. Gunakan kredensial dengan izin EC2 seperlunya saja.
        </p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Tambah akun</h2>
        <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-2" autoComplete="off">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Nama</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="prod-ap" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Region</span>
            <select className={inputClass} value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Access key ID</span>
            <input className={`${inputClass} font-mono`} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value.trim())} required minLength={16} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Secret access key</span>
            <input className={`${inputClass} font-mono`} type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value.trim())} required minLength={16} />
          </label>
          <div className="sm:col-span-2 flex justify-end">
            <button className={buttonClass} disabled={saving}>
              {saving ? 'Menyimpan…' : 'Simpan akun'}
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Daftar akun</div>
        {!accounts && !error && <Spinner />}
        {accounts && accounts.length === 0 && <EmptyState title="Belum ada akun AWS." />}
        {accounts && accounts.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {a.name} <span className="font-normal text-slate-500">· {a.region}</span>
                  </p>
                  <p className="font-mono text-xs text-slate-500">Access key {a.accessKeyIdHint} · {a.groupCount} group</p>
                  {a.lastVerifiedAt && <p className="text-xs text-emerald-700">Terverifikasi {new Date(a.lastVerifiedAt).toLocaleString('id-ID')}</p>}
                  {a.lastVerifyError && <p className="text-xs text-red-700">Gagal: {a.lastVerifyError}</p>}
                </div>
                <div className="flex gap-2">
                  <button className={ghostButtonClass} onClick={() => onTest(a)} disabled={busyId === a.id}>
                    {busyId === a.id ? 'Menguji…' : 'Uji koneksi'}
                  </button>
                  <button className={dangerButtonClass} onClick={() => onDelete(a)} disabled={busyId === a.id || a.groupCount > 0}>
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
