/**
 * Pembatas percobaan gagal dalam memori (PRD FR-25). Hanya kegagalan yang dihitung;
 * login yang berhasil menghapus hitungan. Di banyak instance, pakai penyimpanan bersama (Redis).
 */
export interface RateCheck {
  allowed: boolean;
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): RateCheck {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
    if (entry.count >= this.maxFailures) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  recordFailure(key: string): void {
    const now = Date.now();
    this.pruneIfLarge(now);
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private pruneIfLarge(now: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
