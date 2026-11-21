import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/rate-limit-store.js';

/** Indikator Redis. Tanpa REDIS_URL dianggap sehat karena rate limit memakai memori. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    if (!this.redis) return indicator.up({ note: 'REDIS_URL belum diset; mode memori' });
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? indicator.up() : indicator.down({ message: `balasan tak terduga: ${pong}` });
    } catch (err) {
      return indicator.down({ message: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
}
