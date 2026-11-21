import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { ipInCidr, parseIp } from '../net/cidr';

/** Rentang alamat yang tidak boleh dituju webhook (cegah SSRF ke jaringan internal). */
const PRIVATE_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

export interface UrlGuardOptions {
  allowInsecure: boolean;
  allowPrivate: boolean;
}

export function isPrivateAddress(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true;
  return PRIVATE_RANGES.some((range) => {
    const isV6Range = range.includes(':');
    if ((parsed.version === 6) !== isV6Range) return false;
    return ipInCidr(ip, range);
  });
}

export interface SafeTarget {
  url: URL;
  /** Alamat yang sudah divalidasi; pengiriman harus terhubung hanya ke alamat ini (lihat pinned-fetch). */
  addresses: string[];
}

/**
 * Memastikan URL tujuan aman: https (atau http bila diizinkan), tanpa kredensial di URL,
 * dan hostname tidak mengarah ke alamat privat. Mengembalikan alamat yang sudah divalidasi
 * agar koneksi bisa dipin ke alamat tersebut dan tidak terkena DNS rebinding.
 */
export async function assertSafeWebhookUrl(raw: string, options: UrlGuardOptions): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('URL tidak valid.');
  }
  const allowedProtocol = url.protocol === 'https:' || (options.allowInsecure && url.protocol === 'http:');
  if (!allowedProtocol) throw new BadRequestException('URL harus memakai https.');
  if (url.username || url.password) throw new BadRequestException('URL tidak boleh memuat kredensial.');

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const resolved = parseIp(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true }).catch(() => []);
  if (resolved.length === 0) throw new BadRequestException('Hostname tujuan tidak dapat diselesaikan.');
  if (!options.allowPrivate && resolved.some((a) => isPrivateAddress(a.address))) {
    throw new BadRequestException('Tujuan mengarah ke alamat privat atau loopback; tidak diizinkan.');
  }
  return { url, addresses: resolved.map((a) => a.address) };
}
