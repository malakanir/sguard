'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, buttonClass, ghostButtonClass, inputClass } from '@/components/ui';
import { api, ApiError, API_URL, setSession } from '@/lib/api';
import type { AuthConfig } from '@/lib/types';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);

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
      const res = await api<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession(res.accessToken, res.refreshToken);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login gagal.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">S</div>
          <h1 className="text-xl font-semibold">Masuk ke SGuard</h1>
          <p className="mt-1 text-sm text-slate-500">Kelola rule firewall tanpa akun AWS.</p>
        </div>
        <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error && <Alert>{error}</Alert>}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Email</span>
            <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Password</span>
            <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className={`${buttonClass} w-full`} disabled={loading}>
            {loading ? 'Memproses…' : 'Login'}
          </button>
          {config?.github && (
            <a href={`${API_URL}/auth/github`} className={`${ghostButtonClass} w-full`}>
              Login dengan GitHub
            </a>
          )}
          <p className="text-center text-sm text-slate-600">
            Belum punya akun?{' '}
            <Link href="/register" className="font-medium text-indigo-600 hover:underline">
              Daftar
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
