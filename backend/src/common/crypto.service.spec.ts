import { createCipheriv, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service.js';
import { EnvKeyProvider } from './env-key-provider.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function legacyV1(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_A, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

describe('CryptoService rotation', () => {
  it('encrypts with the active key and decrypts v2', () => {
    const provider = new EnvKeyProvider(
      config({
        CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
        CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
      }),
    );
    const service = new CryptoService(provider);
    const encrypted = service.encrypt('secret');
    expect(encrypted.startsWith('v2:k2:')).toBe(true);
    expect(service.decrypt(encrypted)).toBe('secret');
    expect(service.isConfigured()).toBe(true);
  });

  it('decrypts old v2 ciphertext after rotation and legacy v1 ciphertext', () => {
    const oldService = new CryptoService(
      new EnvKeyProvider(
        config({
          CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
          CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
        }),
      ),
    );
    const oldEncrypted = oldService.encrypt('secret');
    const service = new CryptoService(
      new EnvKeyProvider(
        config({
          CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
          CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
        }),
      ),
    );
    expect(service.decrypt(oldEncrypted)).toBe('secret');
    expect(service.decrypt(legacyV1('legacy'))).toBe('legacy');
  });

  it('uses the legacy key as id "default" when no map is configured', () => {
    const provider = new EnvKeyProvider(config({ CREDENTIAL_ENCRYPTION_KEY: KEY_A }));
    const service = new CryptoService(provider);
    expect(provider.listKeyIds()).toEqual(['default']);
    expect(service.decrypt(service.encrypt('x'))).toBe('x');
  });

  it('reports not configured and throws when no key is set', () => {
    const service = new CryptoService(new EnvKeyProvider(config({})));
    expect(service.isConfigured()).toBe(false);
    expect(() => service.encrypt('x')).toThrow();
  });
});
