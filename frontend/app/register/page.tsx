'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, buttonClass, Card, inputClass } from '@/components/ui';
import { api, ApiError, setSession } from '@/lib/api';
import type { AuthConfig } from '@/lib/types';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);

  useEffect(() => {
    api<AuthConfig>('/auth/config')
      .then(setConfig)
      .catch(() => setConfig({ emailVerification: false, github: false }));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
      if (config?.emailVerification) {
        // Dengan verifikasi aktif, login baru bisa dilakukan setelah tautan di email diklik.
        setCheckEmail(true);
        return;
      }
      // Tanpa verifikasi, register langsung diikuti login agar demo tetap singkat.
      const res = await api<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession(res.accessToken, res.refreshToken);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Pendaftaran gagal.');
    } finally {
      setLoading(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-sm p-6 text-center">
          <h1 className="text-lg font-semibold">Cek email Anda</h1>
          <p className="mt-2 text-sm text-slate-600">
            Kami mengirim tautan verifikasi ke <span className="font-medium">{email}</span>. Tautan berlaku 24 jam.
          </p>
          <Link href="/login" className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:underline">
            Sudah verifikasi? Login
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">Buat akun baru</h1>
          <p className="mt-1 text-sm text-slate-500">Data Anda hanya terlihat oleh Anda.</p>
        </div>
        <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error && <Alert>{error}</Alert>}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Nama</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Email</span>
            <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Password</span>
            <input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            <span className="mt-1 block text-xs text-slate-500">Minimal 8 karakter.</span>
          </label>
          <button className={`${buttonClass} w-full`} disabled={loading}>
            {loading ? 'Memproses…' : 'Daftar'}
          </button>
          <p className="text-center text-sm text-slate-600">
            Sudah punya akun?{' '}
            <Link href="/login" className="font-medium text-indigo-600 hover:underline">
              Login
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
