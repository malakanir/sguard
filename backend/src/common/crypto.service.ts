import { Global, Inject, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EnvKeyProvider } from './env-key-provider.js';
import { KEY_PROVIDER, KeyProvider } from './key-provider.js';

const UNCONFIGURED = 'Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEYS / CREDENTIAL_ENCRYPTION_KEY).';

/**
 * Enkripsi kredensial at rest (AES-256-GCM) dengan kunci yang bisa dirotasi.
 * Format baru: `v2:<keyId>:<iv>:<tag>:<data>`. Format lama `v1:<iv>:<tag>:<data>` tetap bisa dibaca.
 */
@Injectable()
export class CryptoService {
  constructor(@Inject(KEY_PROVIDER) private readonly provider: KeyProvider) {}

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  encrypt(plain: string): string {
    const keyId = this.provider.activeKeyId();
    const key = this.provider.getKey(keyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v2', keyId, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(value: string): string {
    const parts = value.split(':');
    if (parts[0] === 'v2' && parts.length === 5) {
      const [, keyId, iv, tag, data] = parts;
      return this.open(this.keyFor(keyId), iv, tag, data);
    }
    if (parts[0] === 'v1' && parts.length === 4) {
      const [, iv, tag, data] = parts;
      return this.openWithAnyKey(iv, tag, data);
    }
    throw new Error('Format terenkripsi tidak dikenal.');
  }

  private keyFor(keyId: string): Buffer {
    try {
      return this.provider.getKey(keyId);
    } catch {
      throw new ServiceUnavailableException(UNCONFIGURED);
    }
  }

  /** v1 tidak menyimpan id kunci, jadi dicoba terhadap setiap kunci; GCM menolak kunci yang salah. */
  private openWithAnyKey(iv: string, tag: string, data: string): string {
    if (!this.provider.isConfigured()) throw new ServiceUnavailableException(UNCONFIGURED);
    const candidates = ['default', ...this.provider.listKeyIds()].filter(
      (id, index, all) => all.indexOf(id) === index && this.hasKey(id),
    );
    for (const id of candidates) {
      try {
        return this.open(this.provider.getKey(id), iv, tag, data);
      } catch {
        // Coba kunci berikutnya.
      }
    }
    throw new Error('Data terenkripsi tidak dapat dibuka dengan kunci yang tersedia.');
  }

  private hasKey(keyId: string): boolean {
    try {
      this.provider.getKey(keyId);
      return true;
    } catch {
      return false;
    }
  }

  private open(key: Buffer, iv: string, tag: string, data: string): string {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

@Global()
@Module({
  providers: [CryptoService, { provide: KEY_PROVIDER, useClass: EnvKeyProvider }],
  exports: [CryptoService],
})
export class CryptoModule {}
