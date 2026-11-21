import type { Direction, Protocol } from './types';

/** Teks ringkas untuk port atau rentang port: "22", "8000-8100", atau kosong untuk icmp. */
export function formatPort(port: number | null, portTo: number | null): string {
  if (port === null) return '';
  return portTo !== null && portTo !== port ? `${port}-${portTo}` : String(port);
}

/** Contoh: "INGRESS tcp/22-80 · 0.0.0.0/0". */
export function formatRule(item: {
  direction?: Direction;
  protocol: Protocol;
  port: number | null;
  portTo?: number | null;
  cidr: string;
}): string {
  const port = formatPort(item.port, item.portTo ?? null);
  return `${item.direction ?? 'INGRESS'} ${item.protocol}${port ? `/${port}` : ''} · ${item.cidr}`;
}
