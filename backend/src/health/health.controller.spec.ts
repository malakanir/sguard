import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns the terminus health result', async () => {
    const result = { status: 'ok', info: { database: { status: 'up' } }, error: {}, details: {} };
    const controller = new HealthController({ check: vi.fn(async () => result) } as never, {} as never, {} as never);
    await expect(controller.check()).resolves.toEqual(result);
  });
});
