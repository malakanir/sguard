import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from './memory-rate-limit.store.js';
import { RedisRateLimitStore } from './redis-rate-limit.store.js';
import { selectRateLimitStore } from './rate-limit.module.js';

const MAX = 2;
const WINDOW = 60_000;

describe('MemoryRateLimitStore', () => {
  it('blocks only after max failures inside the window and resets on success', async () => {
    const store = new MemoryRateLimitStore(MAX, WINDOW);
    expect(await store.check('k')).toEqual({ allowed: true, retryAfterSec: 0 });
    await store.recordFailure('k');
    expect((await store.check('k')).allowed).toBe(true);
    await store.recordFailure('k');
    const blocked = await store.check('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    await store.reset('k');
    expect((await store.check('k')).allowed).toBe(true);
  });
});

/** Fake ioredis: INCR+EXPIRE lewat eval, dan multi().get().ttl().exec() mengembalikan [count, ttl]. */
function fakeRedis() {
  const data = new Map<string, { count: number; ttl: number }>();
  const redis = {
    data,
    eval: vi.fn(async (_script: string, _n: number, key: string, ttl: number) => {
      const cur = data.get(key) ?? { count: 0, ttl: -1 };
      cur.count += 1;
      if (cur.count === 1) cur.ttl = ttl;
      data.set(key, cur);
      return cur.count;
    }),
    multi: () => {
      const reads: string[] = [];
      const pipeline = {
        get(key: string) {
          reads.push(`get:${key}`);
          return pipeline;
        },
        ttl(key: string) {
          reads.push(`ttl:${key}`);
          return pipeline;
        },
        async exec() {
          return reads.map((op) => {
            const [kind, key] = [op.slice(0, op.indexOf(':')), op.slice(op.indexOf(':') + 1)];
            const entry = data.get(key);
            if (kind === 'get') return [null, String(entry?.count ?? 0)];
            return [null, entry?.ttl ?? -1];
          });
        },
      };
      return pipeline;
    },
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
  return redis;
}

describe('RedisRateLimitStore', () => {
  it('keeps count and TTL across a simulated restart', async () => {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore(redis, MAX, WINDOW);
    await store.recordFailure('k');
    const restarted = new RedisRateLimitStore(redis, MAX, WINDOW);
    await restarted.recordFailure('k');
    expect((await restarted.check('k')).allowed).toBe(false);
    expect(redis.data.get('rl:k')?.ttl).toBe(60);
    await restarted.reset('k');
    expect((await restarted.check('k')).allowed).toBe(true);
    expect(redis.del).toHaveBeenCalledWith('rl:k');
  });
});

describe('selectRateLimitStore', () => {
  it('uses memory when Redis is absent and Redis when it is set', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(selectRateLimitStore(config, null)).toBeInstanceOf(MemoryRateLimitStore);
    expect(selectRateLimitStore(config, {} as never)).toBeInstanceOf(RedisRateLimitStore);
  });
});
