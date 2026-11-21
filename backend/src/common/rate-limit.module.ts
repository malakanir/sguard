import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { MemoryRateLimitStore } from './memory-rate-limit.store.js';
import { RateLimitStore, RATE_LIMIT_STORE, REDIS_CLIENT } from './rate-limit-store.js';
import { RateLimitRedis, RedisRateLimitStore } from './redis-rate-limit.store.js';

export const LOGIN_MAX_FAILURES = 5;
/** 15 menit, sesuai FR-25. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Memakai Redis bila tersedia, jika tidak memakai memori. */
export function selectRateLimitStore(_config: ConfigService, redis: Redis | null): RateLimitStore {
  return redis
    ? new RedisRateLimitStore(redis as unknown as RateLimitRedis, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)
    : new MemoryRateLimitStore(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis | null => {
        const url = config.get<string>('REDIS_URL');
        return url ? new Redis(url) : null;
      },
    },
    {
      provide: RATE_LIMIT_STORE,
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: selectRateLimitStore,
    },
  ],
  exports: [REDIS_CLIENT, RATE_LIMIT_STORE],
})
export class RateLimitModule {}
