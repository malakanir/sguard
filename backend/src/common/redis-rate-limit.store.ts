import { RateCheck, RateLimitStore } from './rate-limit-store.js';

const INCR_EXPIRE_LUA =
  'local n = redis.call("INCR", KEYS[1]) ' +
  'if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end ' +
  'return n';

interface RedisPipeline {
  get(key: string): RedisPipeline;
  ttl(key: string): RedisPipeline;
  exec(): Promise<unknown>;
}

/** Subset klien ioredis yang dipakai store ini (memudahkan mock di test). */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, key: string, ttlSec: number): Promise<unknown>;
  multi(): RedisPipeline;
  del(key: string): Promise<number>;
}

/** Penghitung INCR + EXPIRE atomik di Redis; hitungan dan TTL diset dalam satu round trip. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  async check(key: string): Promise<RateCheck> {
    const storageKey = `rl:${key}`;
    const result = (await this.redis.multi().get(storageKey).ttl(storageKey).exec()) as
      | [Error | null, string | number | null][]
      | null;
    const count = Number(result?.[0]?.[1] ?? 0);
    const ttl = Number(result?.[1]?.[1] ?? -1);
    if (count >= this.maxFailures && ttl > 0) {
      return { allowed: false, retryAfterSec: ttl };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  async recordFailure(key: string): Promise<void> {
    await this.redis.eval(INCR_EXPIRE_LUA, 1, `rl:${key}`, Math.ceil(this.windowMs / 1000));
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
