import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyProvider } from './key-provider.js';

/**
 * Rotasi berbasis env: CREDENTIAL_ENCRYPTION_KEYS berisi peta id -> kunci base64 (32 byte),
 * sedangkan CREDENTIAL_ENCRYPTION_KEY (legacy) dibaca sebagai id "default".
 */
@Injectable()
export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string | null;

  constructor(config: ConfigService) {
    const rawMap = config.get<string>('CREDENTIAL_ENCRYPTION_KEYS');
    if (rawMap) {
      const parsed = JSON.parse(rawMap) as Record<string, string>;
      for (const [id, value] of Object.entries(parsed)) {
        const key = Buffer.from(value, 'base64');
        if (key.length !== 32) throw new Error(`Kunci "${id}" harus 32 byte dalam base64.`);
        this.keys.set(id, key);
      }
    }
    const legacy = config.get<string>('CREDENTIAL_ENCRYPTION_KEY');
    if (legacy && !this.keys.has('default')) {
      const key = Buffer.from(legacy, 'base64');
      if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY harus 32 byte dalam base64.');
      this.keys.set('default', key);
    }
    const configuredActive = config.get<string>('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID');
    if (configuredActive && !this.keys.has(configuredActive)) {
      throw new Error('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID tidak ditemukan dalam CREDENTIAL_ENCRYPTION_KEYS.');
    }
    this.active = configuredActive ?? this.keys.keys().next().value ?? null;
  }

  isConfigured(): boolean {
    return this.active !== null;
  }

  activeKeyId(): string {
    if (!this.active) throw this.unavailable();
    return this.active;
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw this.unavailable();
    return key;
  }

  listKeyIds(): string[] {
    return [...this.keys.keys()];
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEYS / CREDENTIAL_ENCRYPTION_KEY).',
    );
  }
}
