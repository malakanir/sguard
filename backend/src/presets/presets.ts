/**
 * Preset rule disimpan sebagai konstanta di kode, bukan tabel (PRD bagian 8).
 * sourceCidr adalah nilai awal; user bisa mengganti CIDR saat menerapkan preset.
 */
export interface PresetRule {
  name: string;
  protocol: 'tcp' | 'udp' | 'icmp';
  port: number;
  sourceCidr: string;
  description: string;
}

export interface Preset {
  id: 'web-server' | 'ssh-admin' | 'db-internal';
  name: string;
  description: string;
  rules: PresetRule[];
}

export const PRESETS: Preset[] = [
  {
    id: 'web-server',
    name: 'Web server',
    description: 'HTTP dan HTTPS dari internet.',
    rules: [
      { name: 'HTTP', protocol: 'tcp', port: 80, sourceCidr: '0.0.0.0/0', description: 'Akses web publik' },
      { name: 'HTTPS', protocol: 'tcp', port: 443, sourceCidr: '0.0.0.0/0', description: 'Akses web publik (TLS)' },
    ],
  },
  {
    id: 'ssh-admin',
    name: 'SSH admin',
    description: 'SSH hanya dari IP admin. Ganti CIDR dengan IP admin Anda.',
    rules: [
      {
        name: 'SSH admin',
        protocol: 'tcp',
        port: 22,
        sourceCidr: '203.0.113.10/32',
        description: 'Akses SSH untuk admin',
      },
    ],
  },
  {
    id: 'db-internal',
    name: 'Database internal',
    description: 'PostgreSQL dan MySQL hanya dari jaringan internal 10.0.0.0/8.',
    rules: [
      { name: 'PostgreSQL', protocol: 'tcp', port: 5432, sourceCidr: '10.0.0.0/8', description: 'Database internal' },
      { name: 'MySQL', protocol: 'tcp', port: 3306, sourceCidr: '10.0.0.0/8', description: 'Database internal' },
    ],
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
