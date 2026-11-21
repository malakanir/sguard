import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RiskLevel } from '@prisma/client';
import { GroupAccess, GroupRole } from '../access/group-access.service';
import { paginate } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { simulate } from '../simulator/simulator';
import { SYNC_PORT, SyncPort } from '../sync/sync-port';
import { CreateGroupDto, GroupListQueryDto, ShareGroupDto, SimulateDto, UpdateGroupDto } from './dto/group.dto';

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccess,
    @Inject(SYNC_PORT) private readonly sync: SyncPort,
  ) {}

  async list(userId: string, query: GroupListQueryDto) {
    const { page, limit, search } = query;
    const where: Prisma.SecurityGroupWhereInput = {
      ...this.access.accessibleWhere(userId),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.securityGroup.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { rules: true } },
          user: { select: { name: true } },
          members: { where: { userId }, select: { role: true } },
        },
      }),
      this.prisma.securityGroup.count({ where }),
    ]);
    return paginate(
      items.map(({ _count, user, members, userId: ownerId, ...group }) => ({
        ...group,
        ownerId,
        ownerName: user.name,
        myRole: this.roleOf(userId, ownerId, members[0]?.role),
        ruleCount: _count.rules,
      })),
      total,
      page,
      limit,
    );
  }

  async create(userId: string, dto: CreateGroupDto) {
    if (dto.awsAccountId) {
      const account = await this.prisma.awsAccount.findFirst({ where: { id: dto.awsAccountId, userId } });
      if (!account) throw new NotFoundException('Akun AWS tidak ditemukan.');
    }
    const group = await this.prisma.securityGroup.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description ?? null,
        awsAccountId: dto.awsAccountId ?? null,
      },
    });
    // Group dibuat di cloud saat POST; kalau gagal statusnya FAILED, data tetap tersimpan.
    await this.sync.ensureGroup(group.id);
    return this.findOne(userId, group.id);
  }

  async findOne(userId: string, id: string) {
    const role = await this.access.require(userId, id, 'VIEWER');
    const group = await this.prisma.securityGroup.findUniqueOrThrow({
      where: { id },
      include: {
        rules: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, name: true } },
      },
    });

    const summary = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const rule of group.rules) summary[rule.riskLevel as RiskLevel] += 1;
    return {
      ...group,
      owner: group.user,
      user: undefined,
      myRole: role,
      riskSummary: summary,
    };
  }

  async update(userId: string, id: string, dto: UpdateGroupDto) {
    await this.access.require(userId, id, 'OWNER');
    if (dto.awsAccountId !== undefined) {
      throw new BadRequestException('Akun AWS tidak dapat diubah setelah group dibuat.');
    }
    await this.prisma.securityGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      },
    });
    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.access.require(userId, id, 'OWNER');
    const group = await this.prisma.securityGroup.findUniqueOrThrow({ where: { id } });
    await this.sync.removeGroup(group);
    // Rule dan member ikut terhapus lewat cascade di database.
    await this.prisma.securityGroup.delete({ where: { id } });
  }

  async retrySync(userId: string, id: string) {
    await this.access.require(userId, id, 'EDITOR');
    await this.sync.ensureGroup(id);
    return this.findOne(userId, id);
  }

  async drift(userId: string, id: string) {
    await this.access.require(userId, id, 'VIEWER');
    return this.sync.inspect(id);
  }

  async repairDrift(userId: string, id: string) {
    await this.access.require(userId, id, 'EDITOR');
    return this.sync.repair(id);
  }

  async simulateAccess(userId: string, id: string, dto: SimulateDto) {
    await this.access.require(userId, id, 'VIEWER');
    const rules = await this.prisma.firewallRule.findMany({
      where: { securityGroupId: id },
      select: {
        id: true,
        name: true,
        direction: true,
        protocol: true,
        port: true,
        portTo: true,
        cidr: true,
      },
    });
    const port = dto.protocol === 'icmp' ? null : (dto.port ?? null);
    const result = simulate(rules, {
      sourceIp: dto.sourceIp,
      protocol: dto.protocol,
      port,
      direction: dto.direction ?? 'INGRESS',
    });
    return {
      input: { sourceIp: dto.sourceIp, protocol: dto.protocol, port, direction: dto.direction ?? 'INGRESS' },
      ...result,
    };
  }

  /** Daftar pemilik dan member group (FR-27). */
  async members(userId: string, groupId: string) {
    await this.access.require(userId, groupId, 'VIEWER');
    const group = await this.prisma.securityGroup.findUniqueOrThrow({
      where: { id: groupId },
      select: {
        userId: true,
        user: { select: { id: true, name: true, email: true } },
        members: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    return [
      { userId: group.user.id, name: group.user.name, email: group.user.email, role: 'OWNER' as GroupRole },
      ...group.members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role as GroupRole,
      })),
    ];
  }

  /** Bagikan group ke user lain dengan peran VIEWER atau EDITOR. Hanya pemilik. */
  async share(userId: string, groupId: string, dto: ShareGroupDto) {
    await this.access.require(userId, groupId, 'OWNER');
    const target = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!target) throw new NotFoundException('User dengan email tersebut tidak ditemukan.');
    if (target.id === userId) throw new BadRequestException('Pemilik group sudah memiliki akses penuh.');
    await this.prisma.groupMember.upsert({
      where: { securityGroupId_userId: { securityGroupId: groupId, userId: target.id } },
      update: { role: dto.role },
      create: { securityGroupId: groupId, userId: target.id, role: dto.role },
    });
    return { userId: target.id, name: target.name, email: target.email, role: dto.role };
  }

  /** Hapus member. Pemilik boleh menghapus siapa pun; member boleh keluar sendiri. */
  async removeMember(userId: string, groupId: string, memberId: string): Promise<void> {
    if (memberId !== userId) {
      await this.access.require(userId, groupId, 'OWNER');
    } else {
      await this.access.require(userId, groupId, 'VIEWER');
    }
    const result = await this.prisma.groupMember.deleteMany({
      where: { securityGroupId: groupId, userId: memberId },
    });
    if (result.count === 0) throw new NotFoundException('Member tidak ditemukan.');
  }

  private roleOf(userId: string, ownerId: string, memberRole: string | undefined): GroupRole | null {
    if (ownerId === userId) return 'OWNER';
    if (memberRole === 'EDITOR' || memberRole === 'VIEWER') return memberRole;
    return null;
  }
}
