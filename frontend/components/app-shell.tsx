'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { api, clearToken, getToken } from '@/lib/api';
import type { User } from '@/lib/types';
import { RealtimeToasts } from '@/components/toasts';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/groups', label: 'Security Groups' },
  { href: '/accounts', label: 'Akun AWS' },
  { href: '/notifications', label: 'Notifikasi' },
];
const ADMIN_NAV = { href: '/admin', label: 'Admin' };

/** Halaman privat: tanpa token diarahkan ke /login. */
export function AppShell({ children }: { children: ReactNode }) {
  // usePathname butuh Suspense agar prerender Next.js tidak gagal.
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Memuat…</div>}>
      <ShellFrame>{children}</ShellFrame>
    </Suspense>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api<User>('/auth/me')
      .then((me) => {
        setUser(me);
        setReady(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  function logout() {
    // Cabut refresh token di server; kalau gagal, tetap keluar di sisi browser.
    api('/auth/logout', { method: 'POST' })
      .catch(() => undefined)
      .finally(() => {
        clearToken();
        router.replace('/login');
      });
  }

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Memeriksa sesi…</div>;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2 font-bold text-slate-900">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-sm text-white">S</span>
              SGuard
            </Link>
            <nav className="flex gap-1">
              {[...NAV, ...(user?.role === 'ADMIN' ? [ADMIN_NAV] : [])].map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                      active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">{user?.name}</span>
            <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50">
              Logout
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <RealtimeToasts />
    </div>
  );
}
