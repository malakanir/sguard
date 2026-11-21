'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Card, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export default function VerifyEmailPage() {
  // Suspense diperlukan agar useSearchParams aman saat prerender.
  return (
    <Suspense fallback={<Shell><Spinner label="Memverifikasi email…" /></Shell>}>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const token = useSearchParams().get('token');
  // Tanpa token, hasilnya langsung diketahui saat render; tidak perlu efek.
  const [result, setResult] = useState<{ ok: boolean; message: string | null } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api<{ verified: boolean }>(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => {
        if (!cancelled) setResult({ ok: true, message: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Verifikasi gagal.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <Shell>
        <Alert>Tautan verifikasi tidak lengkap.</Alert>
        <BackToLogin />
      </Shell>
    );
  }
  if (!result) return <Shell><Spinner label="Memverifikasi email…" /></Shell>;
  if (!result.ok) {
    return (
      <Shell>
        <Alert>{result.message}</Alert>
        <BackToLogin />
      </Shell>
    );
  }
  return (
    <Shell>
      <h1 className="text-lg font-semibold">Email terverifikasi</h1>
      <p className="mt-2 text-sm text-slate-600">Akun Anda sudah aktif. Silakan login.</p>
      <BackToLogin />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6 text-center">{children}</Card>
    </div>
  );
}

function BackToLogin() {
  return (
    <Link href="/login" className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:underline">
      Ke halaman login
    </Link>
  );
}
