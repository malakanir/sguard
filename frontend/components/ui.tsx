'use client';

import type { ReactNode } from 'react';
import type { RiskLevel, SyncStatus } from '@/lib/types';

const RISK_STYLE: Record<RiskLevel, string> = {
  HIGH: 'bg-red-100 text-red-800 ring-red-300',
  MEDIUM: 'bg-amber-100 text-amber-800 ring-amber-300',
  LOW: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
};

/** Badge risk memakai teks, bukan warna saja (PRD bagian 10). */
export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${RISK_STYLE[level]}`}>
      {level === 'HIGH' ? '▲' : level === 'MEDIUM' ? '■' : '●'} {level}
    </span>
  );
}

const SYNC_STYLE: Record<SyncStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-700 ring-slate-300',
  SYNCED: 'bg-sky-100 text-sky-800 ring-sky-300',
  FAILED: 'bg-rose-100 text-rose-800 ring-rose-300',
};

export function SyncBadge({ status, error }: { status: SyncStatus; error?: string | null }) {
  return (
    <span
      title={error ?? undefined}
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${SYNC_STYLE[status]}`}
    >
      {status}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const style = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[kind];
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${style}`}>{children}</div>;
}

export function Spinner({ label = 'Memuat…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-3 text-sm">
      <button
        className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Sebelumnya
      </button>
      <span className="text-slate-600">
        Halaman {page} dari {totalPages}
      </span>
      <button
        className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Berikutnya
      </button>
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export const buttonClass =
  'inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

export const ghostButtonClass =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

export const dangerButtonClass =
  'inline-flex items-center justify-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50';
