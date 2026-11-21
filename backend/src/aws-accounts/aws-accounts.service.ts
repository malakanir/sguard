import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudClientResolver } from '../sync/cloud-client-resolver';
import { CreateAwsAccountDto } from './dto/aws-account.dto';

/**
 * Akun AWS untuk sinkronisasi nyata (PRD FR-26). Access key dan secret disimpan terenkripsi
 * (AES-256-GCM). Secret tidak pernah dikembalikan ke klien; access key hanya ditampilkan 4 karakter terakhir.
 */
@Injectable()
export class AwsAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly resolver: CloudClientResolver,
  ) {}

  async list(userId: string) {
    const accounts = await this.prisma.awsAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { groups: true } } },
    });
    return accounts.map(({ _count, ...account }) => this.toView(account, _count.groups));
  }

  async create(userId: string, dto: CreateAwsAccountDto) {
    const exists = await this.prisma.awsAccount.findFirst({ where: { userId, name: dto.name } });
    if (exists) throw new ConflictException('Nama akun AWS sudah dipakai.');
    const account = await this.prisma.awsAccount.create({
      data: {
        userId,
        name: dto.name,
        region: dto.region,
        accessKeyIdEnc: this.crypto.encrypt(dto.accessKeyId),
        secretAccessKeyEnc: this.crypto.encrypt(dto.secretAccessKey),
        ...(dto.roleArn ? { roleArn: dto.roleArn } : {}),
        ...(dto.externalId ? { externalIdEnc: this.crypto.encrypt(dto.externalId) } : {}),
        ...(dto.sessionDuration ? { sessionDuration: dto.sessionDuration } : {}),
      },
    });
    return this.toView(account, 0);
  }

  async remove(userId: string, id: string): Promise<void> {
    const account = await this.owned(userId, id);
    const used = await this.prisma.securityGroup.count({ where: { awsAccountId: account.id } });
    if (used > 0) {
      throw new ConflictException(`Akun masih dipakai oleh ${used} group. Lepaskan group tersebut dulu.`);
    }
    await this.prisma.awsAccount.delete({ where: { id: account.id } });
  }

  /** Memastikan kredensial dan region berfungsi. Hasilnya disimpan di akun. */
  async test(userId: string, id: string) {
    const account = await this.owned(userId, id);
    let error: string | null = null;
    try {
      const client = await this.resolver.forAccount(account.id);
      await client.verify();
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 200);
    }
    const updated = await this.prisma.awsAccount.update({
      where: { id: account.id },
      data: { lastVerifiedAt: error ? null : new Date(), lastVerifyError: error },
    });
    const groups = await this.prisma.securityGroup.count({ where: { awsAccountId: account.id } });
    return this.toView(updated, groups);
  }

  private async owned(userId: string, id: string) {
    const account = await this.prisma.awsAccount.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException('Akun AWS tidak ditemukan.');
    return account;
  }

  private toView(
    account: {
      id: string;
      name: string;
      region: string;
      accessKeyIdEnc: string;
      roleArn: string | null;
      externalIdEnc: string | null;
      sessionDuration: number;
      lastVerifiedAt: Date | null;
      lastVerifyError: string | null;
      createdAt: Date;
    },
    groupCount: number,
  ) {
    const accessKeyId = this.crypto.decrypt(account.accessKeyIdEnc);
    return {
      id: account.id,
      name: account.name,
      region: account.region,
      accessKeyIdHint: `****${accessKeyId.slice(-4)}`,
      roleArn: account.roleArn,
      sessionDuration: account.sessionDuration,
      // externalId tidak pernah dikembalikan ke klien; hanya indikator bahwa ada.
      hasExternalId: Boolean(account.externalIdEnc),
      groupCount,
      lastVerifiedAt: account.lastVerifiedAt,
      lastVerifyError: account.lastVerifyError,
      createdAt: account.createdAt,
    };
  }
}
