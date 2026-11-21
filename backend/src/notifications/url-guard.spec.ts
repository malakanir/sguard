import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { lookup } from 'node:dns/promises';
import { assertSafeWebhookUrl } from './url-guard.js';

describe('assertSafeWebhookUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns resolved public addresses for pinning', async () => {
    const result = await assertSafeWebhookUrl('https://hooks.example.com/x', {
      allowInsecure: false,
      allowPrivate: false,
    });
    expect(result.url.hostname).toBe('hooks.example.com');
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('rejects private addresses', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(
      assertSafeWebhookUrl('https://hooks.example.com/x', { allowInsecure: false, allowPrivate: false }),
    ).rejects.toThrow(/privat|loopback/);
  });

  it('still resolves addresses when private targets are allowed', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
    const result = await assertSafeWebhookUrl('https://internal.example.com/x', {
      allowInsecure: false,
      allowPrivate: true,
    });
    expect(result.addresses).toEqual(['10.0.0.5']);
  });
});
