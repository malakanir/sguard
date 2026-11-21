import { RiskLevel } from '@prisma/client';
import { isOpenToWorld, isWideCidr } from '../net/cidr';

export type Direction = 'INGRESS' | 'EGRESS';

export interface RuleSpec {
  /** Default INGRESS, sesuai Fase 1. */
  direction?: Direction;
  protocol: 'tcp' | 'udp' | 'icmp';
  port: number | null;
  /** Ujung rentang port. Null berarti port tunggal. */
  portTo?: number | null;
  cidr: string;
}

export interface RiskAssessment {
  riskLevel: RiskLevel;
  riskReason: string;
  recommendation: string | null;
}

const SENSITIVE_PORTS = new Map<number, string>([
  [22, 'SSH'],
  [3389, 'RDP'],
  [3306, 'MySQL'],
  [5432, 'PostgreSQL'],
  [6379, 'Redis'],
  [27017, 'MongoDB'],
]);
const WEB_PORTS = new Set([80, 443]);

/** Rentang port efektif, atau null untuk icmp. */
export function portRangeOf(spec: Pick<RuleSpec, 'protocol' | 'port' | 'portTo'>): { from: number; to: number } | null {
  if (spec.protocol === 'icmp' || spec.port === null) return null;
  return { from: spec.port, to: spec.portTo ?? spec.port };
}

/**
 * Risk scoring (PRD bagian 9), dievaluasi berurutan:
 * Ingress:
 *   HIGH   terbuka ke internet dan rentang mencakup port sensitif
 *   MEDIUM terbuka ke internet selain 80 dan 443, atau CIDR terlalu lebar
 *   LOW    sisanya (termasuk icmp dan CIDR sempit)
 * Egress: akses keluar umumnya dibutuhkan. Hanya MEDIUM bila semua port terbuka ke internet.
 */
export function assessRisk(spec: RuleSpec): RiskAssessment {
  const range = portRangeOf(spec);
  const open = isOpenToWorld(spec.cidr);

  if (spec.direction === 'EGRESS') {
    if (open && range && range.from === 1 && range.to === 65535) {
      return {
        riskLevel: 'MEDIUM',
        riskReason: 'Egress ke seluruh internet untuk semua port.',
        recommendation: 'Batasi tujuan egress ke layanan yang dibutuhkan.',
      };
    }
    return { riskLevel: 'LOW', riskReason: 'Tanpa temuan.', recommendation: null };
  }

  if (open && range) {
    const sensitive = [...SENSITIVE_PORTS.entries()].find(([port]) => port >= range.from && port <= range.to);
    if (sensitive) {
      const [port, label] = sensitive;
      const reason =
        range.from === range.to
          ? `Port ${port} (${label}) terbuka ke seluruh internet.`
          : `Rentang port ${range.from}-${range.to} mencakup port ${port} (${label}) dan terbuka ke seluruh internet.`;
      return {
        riskLevel: 'HIGH',
        riskReason: reason,
        recommendation: 'Batasi CIDR ke IP admin, misalnya /32.',
      };
    }
    const onlyWeb = range.from === range.to && WEB_PORTS.has(range.from);
    if (!onlyWeb) {
      const reason =
        range.from === range.to
          ? `Port ${range.from} terbuka ke seluruh internet.`
          : `Rentang port ${range.from}-${range.to} terbuka ke seluruh internet.`;
      return {
        riskLevel: 'MEDIUM',
        riskReason: reason,
        recommendation: 'Pastikan layanan ini memang perlu diakses publik.',
      };
    }
  }

  if (!open && isWideCidr(spec.cidr)) {
    return {
      riskLevel: 'MEDIUM',
      riskReason: `CIDR ${spec.cidr} terlalu lebar.`,
      recommendation: 'Persempit CIDR ke subnet yang dibutuhkan, misalnya /24 atau /32.',
    };
  }

  return { riskLevel: 'LOW', riskReason: 'Tanpa temuan.', recommendation: null };
}
