import type { Direction, Protocol, RiskLevel } from './types';

const SENSITIVE: Record<number, string> = {
  22: 'SSH',
  3389: 'RDP',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
};

/** Pratinjau bantuan tampilan, mengikuti aturan backend (PRD bagian 9). Nilai tersimpan tetap dari backend. */
export function previewRisk(
  direction: Direction,
  protocol: Protocol,
  port: number | null,
  portTo: number | null,
  cidr: string,
): { level: RiskLevel; reason: string; recommendation: string | null } {
  const low = { level: 'LOW' as const, reason: 'Tanpa temuan.', recommendation: null };
  if (protocol === 'icmp' || port === null) return low;
  const from = port;
  const to = portTo ?? port;
  const open = /^(0\.0\.0\.0\/0|::\/0)$/.test(cidr.trim());

  if (direction === 'EGRESS') {
    if (open && from === 1 && to === 65535) {
      return {
        level: 'MEDIUM',
        reason: 'Egress ke seluruh internet untuk semua port.',
        recommendation: 'Batasi tujuan egress ke layanan yang dibutuhkan.',
      };
    }
    return low;
  }

  if (open) {
    const hit = Object.keys(SENSITIVE)
      .map(Number)
      .sort((a, b) => a - b)
      .find((p) => p >= from && p <= to);
    if (hit !== undefined) {
      return {
        level: 'HIGH',
        reason:
          from === to
            ? `Port ${hit} (${SENSITIVE[hit]}) terbuka ke seluruh internet.`
            : `Rentang port ${from}-${to} mencakup port ${hit} (${SENSITIVE[hit]}) dan terbuka ke seluruh internet.`,
        recommendation: 'Batasi CIDR ke IP admin, misalnya /32.',
      };
    }
    const onlyWeb = from === to && (from === 80 || from === 443);
    if (!onlyWeb) {
      return {
        level: 'MEDIUM',
        reason: from === to ? `Port ${from} terbuka ke seluruh internet.` : `Rentang port ${from}-${to} terbuka ke seluruh internet.`,
        recommendation: 'Pastikan layanan ini memang perlu diakses publik.',
      };
    }
  }
  return low;
}
