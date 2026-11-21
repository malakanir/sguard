import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { CLOUD_CLIENT, CloudClient, Ec2CloudClient } from './cloud-client';

/**
 * Memilih klien cloud untuk sebuah group: akun AWS yang dihubungkan, atau klien default (Floci/stub).
 * Dalam SYNC_MODE=stub tidak ada panggilan ke AWS sama sekali, termasuk untuk akun yang dihubungkan.
 */
@Injectable()
export class CloudClientResolver {
  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
    @Inject(CLOUD_CLIENT) private readonly defaultClient: CloudClient,
  ) {}

  async forAccount(awsAccountId: string | null | undefined): Promise<CloudClient> {
    if (!awsAccountId || this.config.get<string>('SYNC_MODE') === 'stub') return this.defaultClient;
    const account = await this.prisma.awsAccount.findUnique({ where: { id: awsAccountId } });
    if (!account) throw new NotFoundException('Akun AWS tidak ditemukan.');
    if (!this.crypto.isConfigured()) {
      throw new ServiceUnavailableException('Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEY).');
    }
    return new Ec2CloudClient({
      region: account.region,
      accessKeyId: this.crypto.decrypt(account.accessKeyIdEnc),
      secretAccessKey: this.crypto.decrypt(account.secretAccessKeyEnc),
    });
  }
}
