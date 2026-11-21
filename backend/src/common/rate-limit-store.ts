/**
 * Pembatas percobaan gagal (PRD FR-25). Hanya kegagalan yang dihitung;
 * login yang berhasil menghapus hitungan. Implementasi bisa memori (satu instance)
 * atau Redis (dibagikan antar instance dan bertahan saat restart).
 */
export interface RateCheck {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimitStore {
  check(key: string): Promise<RateCheck>;
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
