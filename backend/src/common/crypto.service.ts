import { Global, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Enkripsi kredensial at rest (AES-256-GCM). Kunci dari CREDENTIAL_ENCRYPTION_KEY (32 byte, base64).
 * Kunci tidak pernah disimpan di database. Untuk produksi, kunci sebaiknya dikelola KMS.
 */
@Injectable()
export class CryptoService {
  private readonly key?: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('CREDENTIAL_ENCRYPTION_KEY');
    if (raw) {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        throw new Error('CREDENTIAL_ENCRYPTION_KEY harus 32 byte dalam base64.');
      }
      this.key = key;
    }
  }

  isConfigured(): boolean {
    return this.key !== undefined;
  }

  encrypt(plain: string): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(value: string): string {
    const key = this.requireKey();
    const [version, iv, tag, data] = value.split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Format terenkripsi tidak dikenal.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException('Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEY).');
    }
    return this.key;
  }
}

@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
