import { ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Peran efektif user terhadap sebuah group. */
export type GroupRole = 'OWNER' | 'EDITOR' | 'VIEWER';

const RANK: Record<GroupRole, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

/**
 * Aturan akses group (FR-27). Pemilik punya semua hak. EDITOR boleh mengubah rule dan sync.
 * VIEWER hanya membaca. Non-member mendapat 404, supaya keberadaan group tidak bocor.
 */
@Injectable()
export class GroupAccess {
  constructor(private readonly prisma: PrismaService) {}

  async roleFor(userId: string, groupId: string): Promise<GroupRole | null> {
    const group = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      select: { userId: true, members: { where: { userId }, select: { role: true } } },
    });
    if (!group) return null;
    if (group.userId === userId) return 'OWNER';
    const member = group.members[0];
    return member ? member.role : null;
  }

  /** Memastikan user punya peran minimal. Melempar 404 bila tidak punya akses sama sekali. */
  async require(userId: string, groupId: string, minimum: GroupRole) {
    const role = await this.roleFor(userId, groupId);
    if (!role) throw new NotFoundException('Security group tidak ditemukan.');
    if (RANK[role] < RANK[minimum]) {
      throw new ForbiddenException(
        minimum === 'OWNER'
          ? 'Hanya pemilik group yang dapat melakukan ini.'
          : 'Anda hanya dapat melihat group ini (peran VIEWER).',
      );
    }
    return role;
  }

  /** Kondisi Prisma untuk group yang bisa dilihat user: miliknya atau yang dibagikan kepadanya. */
  accessibleWhere(userId: string): Prisma.SecurityGroupWhereInput {
    return { OR: [{ userId }, { members: { some: { userId } } }] };
  }

  async accessibleGroupIds(userId: string): Promise<string[]> {
    const groups = await this.prisma.securityGroup.findMany({
      where: this.accessibleWhere(userId),
      select: { id: true },
    });
    return groups.map((g) => g.id);
  }

  /** Semua user yang boleh menerima event group: pemilik dan member. */
  async audienceOf(groupId: string): Promise<{ ownerId: string; audience: string[] } | null> {
    const group = await this.prisma.securityGroup.findUnique({
      where: { id: groupId },
      select: { userId: true, members: { select: { userId: true } } },
    });
    if (!group) return null;
    return {
      ownerId: group.userId,
      audience: [group.userId, ...group.members.map((m) => m.userId)],
    };
  }
}

@Global()
@Module({
  providers: [GroupAccess],
  exports: [GroupAccess],
})
export class AccessModule {}
