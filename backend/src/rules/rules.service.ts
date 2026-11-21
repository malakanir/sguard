import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FirewallRule, Prisma, RiskLevel } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { GroupAccess } from '../access/group-access.service';
import { paginate } from '../common/pagination';
import { EVENT_RULE_HIGH, RuleHighEvent } from '../events/app-events';
import { isValidCidr } from '../net/cidr';
import { PrismaService } from '../prisma/prisma.service';
import { assessRisk, Direction, RuleSpec } from '../risk/risk';
import { SYNC_PORT, SyncPort } from '../sync/sync-port';
import { CreateRuleDto, RuleListQueryDto, UpdateRuleDto } from './dto/rule.dto';

const ruleInclude = {
  group: { select: { id: true, name: true, syncStatus: true, flociGroupId: true, awsAccountId: true, userId: true } },
} satisfies Prisma.FirewallRuleInclude;

/** Snapshot rule untuk audit log: isi sebelum dan sesudah perubahan. */
function snapshot(
  rule: Pick<FirewallRule, 'name' | 'direction' | 'protocol' | 'port' | 'portTo' | 'cidr' | 'description' | 'riskLevel'>,
) {
  return {
    name: rule.name,
    direction: rule.direction,
    protocol: rule.protocol,
    port: rule.port,
    portTo: rule.portTo,
    cidr: rule.cidr,
    description: rule.description,
    riskLevel: rule.riskLevel,
  };
}

@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccess,
    @Inject(SYNC_PORT) private readonly sync: SyncPort,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async list(userId: string, query: RuleListQueryDto) {
    const { page, limit, search, risk, groupId } = query;
    const where: Prisma.FirewallRuleWhereInput = {
      group: this.access.accessibleWhere(userId),
      ...(groupId ? { securityGroupId: groupId } : {}),
      ...(risk ? { riskLevel: risk as RiskLevel } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { cidr: { contains: search } },
              { description: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.firewallRule.findMany({
        where,
        orderBy: [{ riskLevel: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: ruleInclude,
      }),
      this.prisma.firewallRule.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async create(userId: string, groupId: string, dto: CreateRuleDto) {
    await this.access.require(userId, groupId, 'EDITOR');
    const spec = this.buildSpec(dto);
    await this.ensureUnique(groupId, spec);

    const risk = assessRisk(spec);
    const rule = await this.prisma.firewallRule.create({
      data: {
        securityGroupId: groupId,
        name: dto.name,
        description: dto.description ?? null,
        ...spec,
        ...risk,
      },
    });
    await this.audit.record({
      userId,
      securityGroupId: groupId,
      ruleId: rule.id,
      action: 'CREATE',
      after: snapshot(rule),
    });
    if (rule.riskLevel === 'HIGH') await this.emitHigh(groupId, rule.id, rule.name, rule.riskReason);
    // Rule disimpan dulu sebagai PENDING, lalu dikirim ke cloud.
    await this.sync.pushRule(rule.id);
    return this.findOne(userId, rule.id);
  }

  async findOne(userId: string, id: string) {
    const rule = await this.prisma.firewallRule.findFirst({
      where: { id, group: this.access.accessibleWhere(userId) },
      include: ruleInclude,
    });
    if (!rule) throw new NotFoundException('Rule tidak ditemukan.');
    return rule;
  }

  async update(userId: string, id: string, dto: UpdateRuleDto) {
    const existing = await this.findOne(userId, id);
    await this.access.require(userId, existing.securityGroupId, 'EDITOR');

    const merged = {
      name: dto.name ?? existing.name,
      direction: dto.direction ?? existing.direction,
      protocol: dto.protocol ?? existing.protocol,
      port: dto.port !== undefined ? (dto.port ?? null) : existing.port,
      portTo: dto.portTo !== undefined ? (dto.portTo ?? null) : existing.portTo,
      cidr: dto.cidr ?? existing.cidr,
    };
    const spec = this.buildSpec(merged);
    if (
      spec.direction !== existing.direction ||
      spec.protocol !== existing.protocol ||
      spec.port !== existing.port ||
      spec.portTo !== existing.portTo ||
      spec.cidr !== existing.cidr
    ) {
      await this.ensureUnique(existing.securityGroupId, spec, id);
    }

    const risk = assessRisk(spec);
    const previous: RuleSpec = {
      direction: existing.direction,
      protocol: existing.protocol,
      port: existing.port,
      portTo: existing.portTo,
      cidr: existing.cidr,
    };
    const updated = await this.prisma.firewallRule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...spec,
        ...risk,
        syncStatus: 'PENDING',
        syncError: null,
      },
    });
    await this.audit.record({
      userId,
      securityGroupId: existing.securityGroupId,
      ruleId: id,
      action: 'UPDATE',
      before: snapshot(existing),
      after: snapshot(updated),
    });
    if (updated.riskLevel === 'HIGH' && existing.riskLevel !== 'HIGH') {
      await this.emitHigh(existing.securityGroupId, id, updated.name, updated.riskReason);
    }
    // Cabut spec lama di cloud, lalu terapkan yang baru.
    await this.sync.pushRule(id, previous);
    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const rule = await this.findOne(userId, id);
    await this.access.require(userId, rule.securityGroupId, 'EDITOR');
    await this.sync.removeRule(rule, rule.group);
    await this.audit.record({
      userId,
      securityGroupId: rule.securityGroupId,
      ruleId: id,
      action: 'DELETE',
      before: snapshot(rule),
    });
    await this.prisma.firewallRule.delete({ where: { id } });
  }

  /** rule.high: rule HIGH dibuat, atau diubah menjadi HIGH (PRD bagian 9). */
  private async emitHigh(groupId: string, ruleId: string, name: string, riskReason: string | null) {
    const audience = await this.access.audienceOf(groupId);
    if (!audience) return;
    const payload: RuleHighEvent = { ...audience, groupId, ruleId, name, riskReason };
    this.events.emit(EVENT_RULE_HIGH, payload);
  }

  /**
   * Validasi protocol, port, rentang, dan CIDR. Melempar 400 dengan pesan yang bisa dibaca user.
   * Dipakai juga oleh rule dari preset.
   */
  buildSpec(dto: {
    direction?: Direction;
    protocol: RuleSpec['protocol'];
    port?: number | null;
    portTo?: number | null;
    cidr: string;
  }): RuleSpec {
    const direction: Direction = dto.direction ?? 'INGRESS';
    const port = dto.port ?? null;
    const portTo = dto.portTo ?? null;
    if (!isValidCidr(dto.cidr)) {
      throw new BadRequestException('cidr harus CIDR IPv4 atau IPv6 yang valid, misalnya 10.0.0.5/32 atau ::/0.');
    }
    if (dto.protocol === 'icmp') {
      if (port !== null || portTo !== null) {
        throw new BadRequestException('port dan portTo harus kosong untuk protocol icmp.');
      }
      return { direction, protocol: 'icmp', port: null, portTo: null, cidr: dto.cidr };
    }
    if (port === null) {
      throw new BadRequestException(`port wajib diisi untuk protocol ${dto.protocol}.`);
    }
    if (portTo !== null && portTo < port) {
      throw new BadRequestException('portTo tidak boleh lebih kecil dari port.');
    }
    return {
      direction,
      protocol: dto.protocol,
      port,
      portTo: portTo !== null && portTo !== port ? portTo : null,
      cidr: dto.cidr,
    };
  }

  /** Kombinasi group, arah, protocol, rentang port, dan cidr harus unik (AWS menolak duplikat). */
  async ensureUnique(groupId: string, spec: RuleSpec, excludeId?: string): Promise<void> {
    const duplicate = await this.prisma.firewallRule.findFirst({
      where: {
        securityGroupId: groupId,
        direction: spec.direction ?? 'INGRESS',
        protocol: spec.protocol,
        port: spec.port,
        portTo: spec.portTo ?? null,
        cidr: spec.cidr,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException('Rule dengan arah, protocol, port, dan CIDR yang sama sudah ada di group ini.');
    }
  }
}
