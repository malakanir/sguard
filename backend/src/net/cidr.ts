/**
 * Parser IP dan CIDR untuk IPv4 dan IPv6, dengan BigInt. Tanpa dependensi tambahan.
 */
export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  value: bigint;
}

export interface ParsedCidr extends ParsedIp {
  prefix: number;
  mask: bigint;
}

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

export function parseIp(ip: string): ParsedIp | null {
  if (ip.includes(':')) return parseIpv6(ip);
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => IPV4_OCTET.test(p))) return null;
  const value = parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
  return { version: 4, value };
}

function parseIpv6(ip: string): ParsedIp | null {
  // Bentuk dengan IPv4 di ekor (::ffff:1.2.3.4) tidak didukung di Fase 2.
  if (ip.includes('.')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => IPV6_GROUP.test(g))) return null;
  const value = groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
  return { version: 6, value };
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const [address, prefixText, ...rest] = cidr.split('/');
  if (rest.length > 0 || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const bits = ip.version === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > bits) return null;
  const full = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (full << BigInt(bits - prefix)) & full;
  return { ...ip, prefix, mask };
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

export function isValidIp(ip: string): boolean {
  return parseIp(ip) !== null;
}

/** IP berada di dalam CIDR. Versi IP harus sama dengan versi CIDR. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = parseIp(ip);
  const net = parseCidr(cidr);
  if (!addr || !net || addr.version !== net.version) return false;
  return (addr.value & net.mask) === (net.value & net.mask);
}

/** Terbuka ke seluruh internet: 0.0.0.0/0 atau ::/0. */
export function isOpenToWorld(cidr: string): boolean {
  const net = parseCidr(cidr);
  return net !== null && net.prefix === 0;
}

/**
 * CIDR yang terlalu lebar (PRD FR-24): IPv4 /8 atau lebih lebar (tapi bukan /0),
 * atau IPv6 /32 atau lebih lebar (tapi bukan /0).
 */
export function isWideCidr(cidr: string): boolean {
  const net = parseCidr(cidr);
  if (!net || net.prefix === 0) return false;
  return net.version === 4 ? net.prefix <= 8 : net.prefix <= 32;
}
