import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  IpPermission,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { Direction, RuleSpec } from '../risk/risk';

export interface DescribedRules {
  /** Rule yang bentuknya dikelola SGuard (protocol tcp, udp, atau icmp dengan CIDR IPv4 atau IPv6). */
  rules: RuleSpec[];
  /** Jumlah rule yang bentuknya di luar cakupan (misalnya protocol -1). Tidak diubah. */
  unsupported: number;
}

/** Abstraksi di atas Floci atau AWS. Controller dan service lain tidak tahu implementasinya. */
export interface CloudClient {
  createGroup(name: string, description: string): Promise<string>;
  deleteGroup(groupId: string): Promise<void>;
  authorize(groupId: string, rule: RuleSpec): Promise<void>;
  revoke(groupId: string, rule: RuleSpec): Promise<void>;
  describe(groupId: string): Promise<DescribedRules>;
  /** Memastikan kredensial dan endpoint berfungsi. */
  verify(): Promise<void>;
}

export const CLOUD_CLIENT = Symbol('CLOUD_CLIENT');

/** Kode error AWS yang berarti "sudah dalam keadaan yang diinginkan". */
export const IDEMPOTENT_CODES = new Set(['InvalidPermission.Duplicate', 'InvalidPermission.NotFound']);

export function errorCode(err: unknown): string {
  const e = err as { name?: string; Code?: string };
  return e?.Code ?? e?.name ?? 'UnknownError';
}

/** Kunci unik sebuah rule, untuk perbandingan database dengan cloud. */
export function ruleKey(rule: RuleSpec): string {
  const direction: Direction = rule.direction ?? 'INGRESS';
  return `${direction}|${rule.protocol}|${rule.port ?? ''}|${rule.portTo ?? ''}|${rule.cidr}`;
}

function toPermission(rule: RuleSpec): IpPermission {
  // ICMP tidak punya port di AWS; FromPort dan ToPort = -1 berarti semua tipe.
  const from = rule.protocol === 'icmp' ? -1 : (rule.port as number);
  const to = rule.protocol === 'icmp' ? -1 : (rule.portTo ?? rule.port as number);
  const isV6 = rule.cidr.includes(':');
  return {
    IpProtocol: rule.protocol,
    FromPort: from,
    ToPort: to,
    ...(isV6 ? { Ipv6Ranges: [{ CidrIpv6: rule.cidr }] } : { IpRanges: [{ CidrIp: rule.cidr }] }),
  };
}

export interface Ec2Options {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Token sesi dari STS AssumeRole; kosong untuk access key statis. */
  sessionToken?: string;
}

/** Klien nyata lewat AWS SDK v3 EC2. Dipakai untuk Floci (endpoint lokal) maupun AWS sungguhan. */
export class Ec2CloudClient implements CloudClient {
  private readonly ec2: EC2Client;

  constructor(options: Ec2Options) {
    this.ec2 = new EC2Client({
      region: options.region,
      endpoint: options.endpoint,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      },
    });
  }

  async createGroup(name: string, description: string): Promise<string> {
    const res = await this.ec2.send(
      new CreateSecurityGroupCommand({ GroupName: name, Description: description || name }),
    );
    if (!res.GroupId) throw new Error('Cloud tidak mengembalikan GroupId');
    return res.GroupId;
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
  }

  async authorize(groupId: string, rule: RuleSpec): Promise<void> {
    const params = { GroupId: groupId, IpPermissions: [toPermission(rule)] };
    if ((rule.direction ?? 'INGRESS') === 'EGRESS') {
      await this.ec2.send(new AuthorizeSecurityGroupEgressCommand(params));
    } else {
      await this.ec2.send(new AuthorizeSecurityGroupIngressCommand(params));
    }
  }

  async revoke(groupId: string, rule: RuleSpec): Promise<void> {
    const params = { GroupId: groupId, IpPermissions: [toPermission(rule)] };
    if ((rule.direction ?? 'INGRESS') === 'EGRESS') {
      await this.ec2.send(new RevokeSecurityGroupEgressCommand(params));
    } else {
      await this.ec2.send(new RevokeSecurityGroupIngressCommand(params));
    }
  }

  async describe(groupId: string): Promise<DescribedRules> {
    const res = await this.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    const group = res.SecurityGroups?.[0];
    if (!group) {
      throw Object.assign(new Error('Group tidak ditemukan di cloud'), { Code: 'InvalidGroup.NotFound' });
    }
    const rules: RuleSpec[] = [];
    let unsupported = 0;
    const collect = (permissions: IpPermission[] | undefined, direction: Direction) => {
      for (const perm of permissions ?? []) {
        const protocol = perm.IpProtocol;
        const cidrs = [
          ...(perm.IpRanges ?? []).map((r) => r.CidrIp ?? ''),
          ...(perm.Ipv6Ranges ?? []).map((r) => r.CidrIpv6 ?? ''),
        ];
        if (protocol === 'icmp') {
          for (const cidr of cidrs) rules.push({ direction, protocol: 'icmp', port: null, cidr });
        } else if ((protocol === 'tcp' || protocol === 'udp') && perm.FromPort !== undefined && perm.ToPort !== undefined) {
          const portTo = perm.ToPort === perm.FromPort ? null : perm.ToPort;
          for (const cidr of cidrs) rules.push({ direction, protocol, port: perm.FromPort, portTo, cidr });
        } else {
          unsupported += Math.max(cidrs.length, 1);
        }
      }
    };
    collect(group.IpPermissions, 'INGRESS');
    collect(group.IpPermissionsEgress, 'EGRESS');
    return { rules, unsupported };
  }

  async verify(): Promise<void> {
    await this.ec2.send(new DescribeRegionsCommand({ RegionNames: [] }));
  }
}

/** Mode stub untuk deployment server, pengujian, dan ketika Floci tidak tersedia (PRD bagian 11). */
export class StubCloudClient implements CloudClient {
  private readonly groups = new Map<string, Map<string, RuleSpec>>();

  async createGroup(): Promise<string> {
    const id = `sg-stub-${Math.random().toString(16).slice(2, 10)}`;
    this.groups.set(id, new Map());
    return id;
  }

  async deleteGroup(groupId: string): Promise<void> {
    this.groups.delete(groupId);
  }

  async authorize(groupId: string, rule: RuleSpec): Promise<void> {
    const rules = this.groups.get(groupId);
    if (!rules) throw Object.assign(new Error('Group tidak ditemukan'), { Code: 'InvalidGroup.NotFound' });
    if (rules.has(ruleKey(rule))) {
      throw Object.assign(new Error('Rule duplikat'), { Code: 'InvalidPermission.Duplicate' });
    }
    rules.set(ruleKey(rule), { ...rule, direction: rule.direction ?? 'INGRESS' });
  }

  async revoke(groupId: string, rule: RuleSpec): Promise<void> {
    const rules = this.groups.get(groupId);
    if (!rules?.delete(ruleKey(rule))) {
      throw Object.assign(new Error('Rule tidak ditemukan'), { Code: 'InvalidPermission.NotFound' });
    }
  }

  async describe(groupId: string): Promise<DescribedRules> {
    const rules = this.groups.get(groupId);
    if (!rules) throw Object.assign(new Error('Group tidak ditemukan'), { Code: 'InvalidGroup.NotFound' });
    return { rules: [...rules.values()], unsupported: 0 };
  }

  async verify(): Promise<void> {
    // Stub selalu dianggap valid; tidak ada panggilan jaringan.
  }
}
