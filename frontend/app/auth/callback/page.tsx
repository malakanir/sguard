'use client';

import { useEffect } from 'react';
import { Card, Spinner } from '@/components/ui';
import { setSession } from '@/lib/api';

/**
 * Menerima token dari login GitHub lewat fragment (#), lalu menyimpannya sebagai sesi.
 * Jika token tidak ada, kembali ke halaman login.
 */
export default function AuthCallbackPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');
    // Hapus fragment dari address bar sebelum pindah halaman.
    window.history.replaceState(null, '', window.location.pathname);
    if (accessToken && refreshToken) {
      setSession(accessToken, refreshToken);
      window.location.replace('/dashboard');
    } else {
      window.location.replace('/login');
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <Spinner label="Masuk…" />
      </Card>
    </div>
  );
}
