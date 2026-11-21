# SGuard Hardening & Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six remaining gaps in the SGuard README: Redis-backed rate limiting, key rotation, webhook DNS-rebinding protection, STS AssumeRole + per-group account changes, a real-integration verification script, and full Docker Compose deployment with `/health`.

**Architecture:** Replace single-purpose singletons with narrow interfaces (`RateLimitStore`, `KeyProvider`, `CloudClient` already exists) and select implementations via Nest DI factories driven by env vars. Keep every public caller signature stable where possible (`CryptoService.encrypt/decrypt`, `CloudClient`), and add a Prisma migration for the STS fields. Network hardening pins outbound webhook connections to DNS-validated addresses at delivery time. All new env vars are documented in `.env.example` and README.

**Tech Stack:** NestJS 12 (ESM, relative imports end in `.js`), Prisma 6, PostgreSQL, Redis 7 via `ioredis`, AWS SDK v3 (`client-ec2`, `client-sts`), `@nestjs/terminus`, Vitest 4 (`vi.fn()`), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-21-sguard-hardening-completion-design.md` (read it alongside this plan).

## Global Constraints

- NestJS ESM only: relative imports end in `.js`; use `import.meta.dirname`. Do not use `__dirname`.
- Tests are Vitest with `vi.fn()` — never `jest.fn()`. Unit test files are `*.spec.ts`; `backend/vitest.config.ts` includes `**/*.spec.ts` under `backend/`.
- Prefer first-party Nest packages (`@nestjs/terminus`, etc.) over third-party equivalents.
- Validation: `ValidationPipe` + `class-validator` decorators (already global in this project).
- Keep Indonesian UI/error copy style where existing errors are Indonesian; new user-facing errors should match that tone. Docs in this pass are English per the approved spec.
- `npm`/`pnpm` install of new dependencies requires network access — if it fails, stop and report rather than hand-rolling a substitute.
- Apply `prisma migrate dev` / `prisma generate` before compiling code that references new schema fields.
- Floci is not a KMS. No KMS/Vault dependency in this pass.
- Do not run real AWS/Slack/SMTP verification; only provide the script and docs.

## Review Focus

These are the spec-implied failure modes no existing test covers. Each line is pinned to a test in the owning task.

1. **Login lockout survives a process restart** — a failed-login counter stored in Redis must still block after the backend restarts; pinned by Task 1 redis-store test asserting count + TTL round-trip through the fake Redis.
2. **Successful login clears old failures** — after N failures then one success, the old counter must not keep blocking; pinned by Task 1 memory-store test, which calls `reset` and asserts the next `check` is allowed. Task 1 Step 9 also verifies `AuthService.login` calls `await this.loginLimiter.reset(key)` on success.
3. **Rotated-out keys still decrypt old ciphertext** — after `activeKeyId()` changes, v2 ciphertext written under the previous id and v1 ciphertext must both decrypt; pinned by Task 2 rotation test.
4. **DNS rebinding between validation and connect** — an address that changes after validation must not receive the webhook; pinned by Task 3 pinned-fetch test asserting the connection uses the validated address only.
5. **Group account change resets cloud state** — changing `awsAccountId` must clear `flociGroupId`, set `syncStatus=PENDING`, clear `syncError`, and call `sync.ensureGroup()`; pinned by Task 5 update test.
6. **STS credentials must include a session token** — assume-role output must be passed to `EC2Client`; pinned by Task 4 resolver test.

---

## Task 1: Distributed rate-limit store

**Files:**
- Create: `backend/src/common/rate-limit-store.ts`
- Create: `backend/src/common/memory-rate-limit.store.ts`
- Create: `backend/src/common/redis-rate-limit.store.ts`
- Create: `backend/src/common/rate-limit.module.ts`
- Test: `backend/src/common/rate-limit-store.spec.ts`
- Modify: `backend/src/auth/auth.service.ts:11,35,78,88,91`
- Modify: `backend/src/app.module.ts:20,28`
- Modify: `backend/package.json` (add `ioredis`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ConfigService.get('REDIS_URL')`; existing `LOGIN_MAX_FAILURES = 5`, `LOGIN_WINDOW_MS = 15 * 60 * 1000` from `auth.service.ts`.
- Produces:
  - `RateCheck { allowed: boolean; retryAfterSec: number }`
  - `RateLimitStore { check(key): Promise<RateCheck>; recordFailure(key): Promise<void>; reset(key): Promise<void> }`
  - `RATE_LIMIT_STORE` DI symbol
  - `REDIS_CLIENT` DI symbol (`Redis | null`) — reused by Task 7 health check
  - `RateLimitModule` (global), exporting `RATE_LIMIT_STORE` and `REDIS_CLIENT`

- [ ] **Step 1: Install ioredis**

Run: `cd backend && pnpm add ioredis`
Expected: dependency added; if network fails, stop and report.

- [ ] **Step 2: Write failing test for store contract and selector**

Create `backend/src/common/rate-limit-store.spec.ts`:

```ts
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
    expect(await store.check('k').then((r) => r.allowed)).toBe(true);
    await store.recordFailure('k');
    const blocked = await store.check('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    await store.reset('k');
    expect(await store.check('k').then((r) => r.allowed)).toBe(true);
  });
});

describe('RedisRateLimitStore', () => {
  function fakeRedis() {
    const data = new Map<string, { count: number; ttl: number }>();
    return {
      data,
      eval: vi.fn(async (_script: string, _n: number, key: string, ttl: number) => {
        const cur = data.get(key) ?? { count: 0, ttl: 0 };
        cur.count += 1;
        if (cur.count === 1) cur.ttl = ttl;
        data.set(key, cur);
        return cur.count;
      }),
      multi: () => ({
        get: (_key: string) => undefined,
        ttl: (_key: string) => undefined,
        exec: async () => {
          const entry = data.get('rl:k');
          return [[null, String(entry?.count ?? 0)], [null, entry?.ttl ?? -1]];
        },
      }),
      del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
    };
  }

  it('keeps count and TTL across a simulated restart', async () => {
    const redis = fakeRedis();
    const store = new RedisRateLimitStore(redis as never, MAX, WINDOW);
    await store.recordFailure('k');
    const restarted = new RedisRateLimitStore(redis as never, MAX, WINDOW);
    await restarted.recordFailure('k');
    expect((await restarted.check('k')).allowed).toBe(false);
    const ttl = redis.data.get('rl:k')?.ttl;
    expect(ttl).toBe(60);
    await restarted.reset('k');
    expect((await restarted.check('k')).allowed).toBe(true);
  });
});

describe('selectRateLimitStore', () => {
  it('uses memory when REDIS_URL is empty and Redis when set', () => {
    expect(selectRateLimitStore({ get: () => undefined } as never, null)).toBeInstanceOf(MemoryRateLimitStore);
    const redisStore = selectRateLimitStore(
      { get: () => 'redis://localhost:6379' } as never,
      {} as never,
    );
    expect(redisStore).toBeInstanceOf(RedisRateLimitStore);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/common/rate-limit-store.spec.ts`
Expected: FAIL — modules `./memory-rate-limit.store.js`, `./redis-rate-limit.store.js`, `./rate-limit.module.js` do not exist.

- [ ] **Step 4: Create the store interfaces**

Create `backend/src/common/rate-limit-store.ts`:

```ts
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
```

- [ ] **Step 5: Create the memory implementation (moves current logic verbatim)**

Create `backend/src/common/memory-rate-limit.store.ts`:

```ts
import { RateCheck, RateLimitStore } from './rate-limit-store.js';

/** In-memory fallback. Same failed-login-only semantics as the original RateLimiter. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  async check(key: string): Promise<RateCheck> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
    if (entry.count >= this.maxFailures) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  async recordFailure(key: string): Promise<void> {
    const now = Date.now();
    this.pruneIfLarge(now);
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private pruneIfLarge(now: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
```

- [ ] **Step 6: Create the Redis implementation**

Create `backend/src/common/redis-rate-limit.store.ts`:

```ts
import { RateCheck, RateLimitStore } from './rate-limit-store.js';

const INCR_EXPIRE_LUA =
  'local n = redis.call("INCR", KEYS[1]) ' +
  'if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end ' +
  'return n';

/** Atomic INCR + EXPIRE; counter and TTL are set in one round trip. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: {
      eval(script: string, numKeys: number, key: string, ttlSec: number): Promise<unknown>;
      multi(): { get(key: string): unknown; ttl(key: string): unknown; exec(): Promise<unknown> };
      del(key: string): Promise<number>;
    },
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  async check(key: string): Promise<RateCheck> {
    const storageKey = `rl:${key}`;
    const result = (await this.redis.multi().get(storageKey).ttl(storageKey).exec()) as
      | [Error | null, string | null][]
      | null;
    const count = Number(result?.[0]?.[1] ?? 0);
    const ttl = Number(result?.[1]?.[1] ?? -1);
    if (count >= this.maxFailures && ttl > 0) {
      return { allowed: false, retryAfterSec: ttl };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  async recordFailure(key: string): Promise<void> {
    await this.redis.eval(
      INCR_EXPIRE_LUA,
      1,
      `rl:${key}`,
      Math.ceil(this.windowMs / 1000),
    );
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
```

The fake Redis returns `[count, ttl]` from `multi().get().ttl().exec()`, matching real `ioredis`. Keep the count-first ordering.

- [ ] **Step 7: Create the DI module and selector**

Create `backend/src/common/rate-limit.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import {
  RATE_LIMIT_STORE,
  RateLimitStore,
  REDIS_CLIENT,
} from './rate-limit-store.js';
import { MemoryRateLimitStore } from './memory-rate-limit.store.js';
import { RedisRateLimitStore } from './redis-rate-limit.store.js';

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Uses the shared Redis connection when configured, otherwise in-memory. */
export function selectRateLimitStore(config: ConfigService, redis: Redis | null): RateLimitStore {
  return redis
    ? new RedisRateLimitStore(redis, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)
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
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/common/rate-limit-store.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Swap AuthService to the injected store**

In `backend/src/auth/auth.service.ts`:
- Replace `import { RateLimiter } from '../common/rate-limit';` with:
  ```ts
  import { Inject } from '@nestjs/common';
  import { RATE_LIMIT_STORE, RateLimitStore } from '../common/rate-limit-store.js';
  ```
- Delete lines `const LOGIN_MAX_FAILURES = 5;`, `const LOGIN_WINDOW_MS = 15 * 60 * 1000;` and the comment above them.
- Replace `private readonly loginLimiter = new RateLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);` with:
  ```ts
  @Inject(RATE_LIMIT_STORE) private readonly loginLimiter: RateLimitStore,
  ```
  added as a constructor parameter (remove the field initializer).
- Replace the three call sites:
  - `const gate = await this.loginLimiter.check(key);`
  - `await this.loginLimiter.recordFailure(key);`
  - `await this.loginLimiter.reset(key);`
- Delete `backend/src/common/rate-limit.ts` (its logic now lives in `memory-rate-limit.store.ts`). Confirm with `grep -rn "common/rate-limit'" backend/src` that nothing imports the old path.

- [ ] **Step 10: Register the module and document the env var**

In `backend/src/app.module.ts`, import `RateLimitModule` from `./common/rate-limit.module.js` and add it to `imports` immediately after `CryptoModule`.

Append to `.env.example`:

```dotenv
# Opsional: jika diset, rate limit login dibagikan lewat Redis (disarankan untuk multi-instance).
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 11: Verify build and tests**

Run: `cd backend && pnpm build && pnpm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 12: Commit**

```bash
git add backend/src/common backend/src/auth/auth.service.ts backend/src/app.module.ts backend/package.json backend/pnpm-lock.yaml .env.example
git commit -m "feat: add Redis-backed rate limit store with in-memory fallback"
```

---

## Task 2: KeyProvider abstraction and v2 ciphertext rotation

**Files:**
- Create: `backend/src/common/key-provider.ts`
- Create: `backend/src/common/env-key-provider.ts`
- Test: `backend/src/common/crypto.service.spec.ts`
- Modify: `backend/src/common/crypto.service.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ConfigService` values `CREDENTIAL_ENCRYPTION_KEYS` (JSON map id→base64), `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID`, legacy `CREDENTIAL_ENCRYPTION_KEY`.
- Produces:
  - `KEY_PROVIDER` DI symbol
  - `KeyProvider { activeKeyId(): string; getKey(id: string): Buffer; listKeyIds(): string[]; isConfigured(): boolean }`
  - `EnvKeyProvider implements KeyProvider`
  - `CryptoService.encrypt(plain: string): string` → `v2:<keyId>:<iv>:<tag>:<data>`
  - `CryptoService.decrypt(value: string): string` → accepts `v1` and `v2`

- [ ] **Step 1: Write failing rotation tests**

Create `backend/src/common/crypto.service.spec.ts`:

```ts
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
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
    const provider = new EnvKeyProvider(config({
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
    }));
    const service = new CryptoService(provider);
    const encrypted = service.encrypt('secret');
    expect(encrypted.startsWith('v2:k2:')).toBe(true);
    expect(service.decrypt(encrypted)).toBe('secret');
    expect(service.isConfigured()).toBe(true);
  });

  it('decrypts old v2 ciphertext after rotation and legacy v1 ciphertext', () => {
    const oldProvider = new EnvKeyProvider(config({
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    }));
    const oldEncrypted = new CryptoService(oldProvider).encrypt('secret');
    const newProvider = new EnvKeyProvider(config({
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
    }));
    const service = new CryptoService(newProvider);
    expect(service.decrypt(oldEncrypted)).toBe('secret');
    expect(service.decrypt(legacyV1('legacy'))).toBe('legacy');
  });

  it('uses the legacy key as id "default" when no map is configured', () => {
    const provider = new EnvKeyProvider(config({ CREDENTIAL_ENCRYPTION_KEY: KEY_A }));
    const service = new CryptoService(provider);
    expect(provider.listKeyIds()).toEqual(['default']);
    expect(service.decrypt(service.encrypt('x'))).toBe('x');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && pnpm exec vitest run src/common/crypto.service.spec.ts`
Expected: FAIL — `env-key-provider.js` missing.

- [ ] **Step 3: Create the provider interface and implementation**

Create `backend/src/common/key-provider.ts`:

```ts
export interface KeyProvider {
  activeKeyId(): string;
  getKey(keyId: string): Buffer;
  listKeyIds(): string[];
  isConfigured(): boolean;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
```

Create `backend/src/common/env-key-provider.ts`:

```ts
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyProvider } from './key-provider.js';

/** Env-based rotation: a JSON map of key ids, plus the legacy single key as "default". */
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
```

- [ ] **Step 4: Rewrite CryptoService to use the provider**

Replace `backend/src/common/crypto.service.ts` with:

```ts
import { Global, Inject, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EnvKeyProvider } from './env-key-provider.js';
import { KEY_PROVIDER, KeyProvider } from './key-provider.js';

/** AES-256-GCM with rotatable keys. v1 records remain decryptable. */
@Injectable()
export class CryptoService {
  constructor(@Inject(KEY_PROVIDER) private readonly provider: KeyProvider) {}

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  encrypt(plain: string): string {
    const keyId = this.provider.activeKeyId();
    const key = this.provider.getKey(keyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v2',
      keyId,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(value: string): string {
    const parts = value.split(':');
    let key: Buffer;
    let iv: string;
    let tag: string;
    let data: string;
    if (parts[0] === 'v1' && parts.length === 4) {
      [, iv, tag, data] = parts;
      key = this.requireKey(this.provider.activeKeyId());
    } else if (parts[0] === 'v2' && parts.length === 5) {
      const [, keyId, iv2, tag2, data2] = parts;
      key = this.requireKey(keyId);
      iv = iv2;
      tag = tag2;
      data = data2;
    } else {
      throw new Error('Format terenkripsi tidak dikenal.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  private requireKey(keyId: string): Buffer {
    try {
      return this.provider.getKey(keyId);
    } catch {
      throw new ServiceUnavailableException(
        'Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEYS / CREDENTIAL_ENCRYPTION_KEY).',
      );
    }
  }
}

@Global()
@Module({
  providers: [
    CryptoService,
    { provide: KEY_PROVIDER, useClass: EnvKeyProvider },
  ],
  exports: [CryptoService],
})
export class CryptoModule {}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/common/crypto.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Document the rotation env vars**

Append to `.env.example`:

```dotenv
# Rotasi kunci enkripsi kredensial. Legacy: CREDENTIAL_ENCRYPTION_KEY (dibaca sebagai id "default").
# CREDENTIAL_ENCRYPTION_KEYS={"k1":"<base64 32 byte>","k2":"<base64 32 byte>"}
CREDENTIAL_ENCRYPTION_KEYS=
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k2
```

- [ ] **Step 7: Verify build and commit**

Run: `cd backend && pnpm build && pnpm test`
Expected: PASS.

```bash
git add backend/src/common/crypto.service.ts backend/src/common/key-provider.ts backend/src/common/env-key-provider.ts backend/src/common/crypto.service.spec.ts .env.example
git commit -m "feat: support key rotation via KeyProvider with v1 ciphertext compatibility"
```

---

## Task 3: Webhook DNS-rebinding protection via address pinning

**Files:**
- Create: `backend/src/notifications/pinned-fetch.ts`
- Create: `backend/src/notifications/url-guard.spec.ts`
- Create: `backend/src/notifications/pinned-fetch.spec.ts`
- Modify: `backend/src/notifications/url-guard.ts:40-60`
- Modify: `backend/src/notifications/notifications.service.ts:140-164,177-195`

**Interfaces:**
- Consumes: `assertSafeWebhookUrl(raw, options)`; `DELIVERY_TIMEOUT_MS` in notifications service.
- Produces:
  - `SafeTarget { url: URL; addresses: string[] }`
  - `assertSafeWebhookUrl(raw, options): Promise<SafeTarget>`
  - `pinnedFetch(url: URL, addresses: string[], init: { method, headers, body, timeoutMs }): Promise<{ status: number }>`

- [ ] **Step 1: Write failing url-guard test**

Create `backend/src/notifications/url-guard.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

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
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(
      assertSafeWebhookUrl('https://hooks.example.com/x', { allowInsecure: false, allowPrivate: false }),
    ).rejects.toThrow(/privat|loopback/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm exec vitest run src/notifications/url-guard.spec.ts`
Expected: FAIL — return is `URL`, not `{ url, addresses }`.

- [ ] **Step 3: Change url-guard to return validated addresses**

In `backend/src/notifications/url-guard.ts`:

Add after `UrlGuardOptions`:

```ts
export interface SafeTarget {
  url: URL;
  addresses: string[];
}
```

Replace the body of `assertSafeWebhookUrl` from `if (!options.allowPrivate)` through `return url;` with:

```ts
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = parseIp(hostname) ? hostname : null;
  const resolved = literal
    ? [{ address: literal }]
    : await lookup(hostname, { all: true }).catch(() => []);
  if (resolved.length === 0) throw new BadRequestException('Hostname tujuan tidak dapat diselesaikan.');
  if (!options.allowPrivate && resolved.some((a) => isPrivateAddress(a.address))) {
    throw new BadRequestException('Tujuan mengarah ke alamat privat atau loopback; tidak diizinkan.');
  }
  return { url, addresses: resolved.map((a) => a.address) };
```

Change the signature to `Promise<SafeTarget>`. Keep the protocol and credential checks unchanged. Resolve even when `allowPrivate` is true — the pinning layer needs the addresses in every case.

- [ ] **Step 4: Run the url-guard test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/notifications/url-guard.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write failing pinned-fetch test**

Create `backend/src/notifications/pinned-fetch.spec.ts`:

```ts
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedFetch } from './pinned-fetch.js';

const servers: ReturnType<typeof createServer>[] = [];

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

describe('pinnedFetch', () => {
  it('connects to the validated address and preserves the original Host header', async () => {
    let seenHost = '';
    const port = await listen((req, res) => {
      seenHost = req.headers.host ?? '';
      res.writeHead(200).end('ok');
    });
    const url = new URL(`http://example.test:${port}/hook`);
    const result = await pinnedFetch(url, ['127.0.0.1'], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 2000,
    });
    expect(result.status).toBe(200);
    expect(seenHost).toBe(`example.test:${port}`);
  });

  it('rejects redirect responses', async () => {
    const port = await listen((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1/' }).end());
    const url = new URL(`http://example.test:${port}/hook`);
    await expect(
      pinnedFetch(url, ['127.0.0.1'], { method: 'POST', headers: {}, body: '', timeoutMs: 2000 }),
    ).rejects.toThrow(/redirect/i);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && pnpm exec vitest run src/notifications/pinned-fetch.spec.ts`
Expected: FAIL — module missing.

- [ ] **Step 7: Implement pinnedFetch**

Create `backend/src/notifications/pinned-fetch.ts`:

```ts
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface PinnedFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * Connects only to addresses already validated by assertSafeWebhookUrl.
 * Host header and TLS SNI keep the original hostname; redirects are never followed.
 */
export async function pinnedFetch(
  url: URL,
  addresses: string[],
  init: PinnedFetchInit,
): Promise<{ status: number }> {
  if (addresses.length === 0) throw new Error('Tidak ada alamat tujuan yang telah divalidasi.');
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const path = `${url.pathname}${url.search}`;
  let lastError: unknown;
  for (const address of addresses) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = (secure ? httpsRequest : httpRequest)(
          {
            hostname: address,
            port,
            path,
            method: init.method,
            headers: { ...init.headers, host: url.host },
            ...(secure ? { servername: url.hostname } : {}),
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.setTimeout(init.timeoutMs, () => req.destroy(new Error('Timeout saat mengirim webhook.')));
        req.on('error', reject);
        req.end(init.body);
      });
      if (status >= 300 && status < 400) throw new Error('Redirect webhook tidak diizinkan.');
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      return { status };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Gagal menghubungi tujuan webhook.');
}
```

- [ ] **Step 8: Run the pinned-fetch test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/notifications/pinned-fetch.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Wire the notifications service to the pinned fetch**

In `backend/src/notifications/notifications.service.ts`:
- Add import: `import { pinnedFetch } from './pinned-fetch.js';`
- In `deliverWebhook`, replace `await this.assertSafe(target);` with `const safe = await this.assertSafe(target);`.
- Replace `await this.postJson(target, body, headers);` with `await this.postJson(safe, body, headers);`.
- Replace `postJson` with:

```ts
  private async postJson(
    safe: { url: URL; addresses: string[] },
    body: string,
    extraHeaders: Record<string, string>,
  ): Promise<void> {
    await pinnedFetch(safe.url, safe.addresses, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SGuard-Notifier/1', ...extraHeaders },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });
  }
```

- In `validateTarget`, replace `await this.assertSafe(target);` with `await this.assertSafe(target);` (unchanged — it only validates).
- Change `private assertSafe(target: string): Promise<URL>` to `private assertSafe(target: string): ReturnType<typeof assertSafeWebhookUrl>`; body unchanged.
- **Search all other call sites** of `assertSafeWebhookUrl` in `backend/src` and adapt each to the new `SafeTarget` shape.

- [ ] **Step 10: Verify build and commit**

Run: `cd backend && pnpm build && pnpm test`
Expected: PASS.

```bash
git add backend/src/notifications
git commit -m "feat: pin webhook connections to DNS-validated addresses"
```

---

## Task 4: STS AssumeRole and Prisma schema support

**Files:**
- Create: `backend/prisma/migrations/20261121000000_sts_assume_role/migration.sql`
- Create: `backend/src/sync/sts.ts`
- Test: `backend/src/sync/sts.spec.ts`
- Modify: `backend/prisma/schema.prisma:190-206`
- Modify: `backend/src/aws-accounts/dto/aws-account.dto.ts`
- Modify: `backend/src/aws-accounts/aws-accounts.service.ts:28-41,76-99`
- Modify: `backend/src/sync/cloud-client.ts:62-78`
- Modify: `backend/src/sync/cloud-client-resolver.ts`
- Modify: `backend/package.json` (add `@aws-sdk/client-sts`)

**Interfaces:**
- Consumes: decrypted `externalIdEnc`, `roleArn`, `sessionDuration` from `AwsAccount`.
- Produces:
  - `assumeRole(input: { region, roleArn, externalId?, sessionDuration }): Promise<{ accessKeyId, secretAccessKey, sessionToken }>`
  - `Ec2Options.sessionToken?: string`
  - `CloudClientResolver.forAccount(...)` unchanged signature

- [ ] **Step 1: Install the STS SDK**

Run: `cd backend && pnpm add @aws-sdk/client-sts`
Expected: dependency added; stop on network failure.

- [ ] **Step 2: Write the failing STS test**

Create `backend/src/sync/sts.spec.ts`:

```ts
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return { ...actual, STSClient: vi.fn(() => ({ send })) };
});

import { assumeRole } from './sts.js';

describe('assumeRole', () => {
  beforeEach(() => send.mockReset());

  it('passes role, external id and duration and returns temporary credentials', async () => {
    send.mockResolvedValueOnce({
      Credentials: { AccessKeyId: 'AKIA_TEMP', SecretAccessKey: 'secret', SessionToken: 'token' },
    });
    const result = await assumeRole({
      region: 'ap-southeast-1',
      roleArn: 'arn:aws:iam::123456789012:role/sguard',
      externalId: 'external-1',
      sessionDuration: 900,
    });
    expect(result).toEqual({ accessKeyId: 'AKIA_TEMP', secretAccessKey: 'secret', sessionToken: 'token' });
    const command = send.mock.calls[0][0] as InstanceType<typeof AssumeRoleCommand>;
    expect(command.input).toMatchObject({
      RoleArn: 'arn:aws:iam::123456789012:role/sguard',
      ExternalId: 'external-1',
      DurationSeconds: 900,
    });
  });

  it('throws when STS omits a session token', async () => {
    send.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b' } });
    await expect(
      assumeRole({ region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/r', sessionDuration: 3600 }),
    ).rejects.toThrow(/session token/i);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && pnpm exec vitest run src/sync/sts.spec.ts`
Expected: FAIL — `sts.js` missing.

- [ ] **Step 4: Implement assumeRole**

Create `backend/src/sync/sts.ts`:

```ts
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

export interface AssumeRoleInput {
  region: string;
  roleArn: string;
  externalId?: string;
  sessionDuration: number;
}

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function assumeRole(input: AssumeRoleInput): Promise<TemporaryCredentials> {
  const sts = new STSClient({ region: input.region });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn,
      RoleSessionName: `sguard-${Date.now()}`,
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
      DurationSeconds: input.sessionDuration,
    }),
  );
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error('STS tidak mengembalikan kredensial sementara lengkap (session token).');
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}
```

- [ ] **Step 5: Run the STS test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/sync/sts.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the Prisma migration and schema fields**

Create `backend/prisma/migrations/20261121000000_sts_assume_role/migration.sql`:

```sql
-- STS AssumeRole support for connected AWS accounts.
ALTER TABLE "aws_accounts"
  ADD COLUMN "role_arn" TEXT,
  ADD COLUMN "external_id_enc" TEXT,
  ADD COLUMN "session_duration" INTEGER NOT NULL DEFAULT 3600;
```

In `backend/prisma/schema.prisma`, inside `model AwsAccount` after `secretAccessKeyEnc`, add:

```prisma
  roleArn         String?   @map("role_arn")
  externalIdEnc   String?   @map("external_id_enc")
  sessionDuration Int       @default(3600) @map("session_duration")
```

Run: `cd backend && pnpm exec prisma migrate deploy && pnpm exec prisma generate`
Expected: migration applied to local DB, client regenerated. If no DB is running, start Postgres via `docker compose up -d postgres` first.

- [ ] **Step 7: Extend the DTO**

In `backend/src/aws-accounts/dto/aws-account.dto.ts`:
- Update the import to include `IsInt`, `IsOptional`, `Max`, `Min`, `Matches`.
- Add to `CreateAwsAccountDto` after `secretAccessKey`:

```ts
  /** ARN peran IAM yang akan di-assume via STS. Kosong berarti pakai access key statis. */
  @IsOptional()
  @IsString()
  @Matches(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/, { message: 'roleArn tidak valid' })
  roleArn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  externalId?: string;

  @IsOptional()
  @IsInt()
  @Min(900)
  @Max(43200)
  sessionDuration?: number;
```

- [ ] **Step 8: Store the new fields on create and expose them**

In `backend/src/aws-accounts/aws-accounts.service.ts`, in `create`'s `data` object add after `secretAccessKeyEnc`:

```ts
        ...(dto.roleArn ? { roleArn: dto.roleArn } : {}),
        ...(dto.externalId ? { externalIdEnc: this.crypto.encrypt(dto.externalId) } : {}),
        ...(dto.sessionDuration ? { sessionDuration: dto.sessionDuration } : {}),
```

In `toView`'s parameter type add `roleArn: string | null; externalIdEnc: string | null; sessionDuration: number;`, and in its return object add:

```ts
      roleArn: account.roleArn,
      sessionDuration: account.sessionDuration,
      hasExternalId: Boolean(account.externalIdEnc),
```

`externalIdEnc` is used only for the boolean and is never returned to the client. `list()` and `test()` pass full account objects, so the wider type is satisfied.

- [ ] **Step 9: Pass session tokens through Ec2Options**

In `backend/src/sync/cloud-client.ts`, add to `Ec2Options`:

```ts
  sessionToken?: string;
```

In the `EC2Client` constructor options, change `credentials` to:

```ts
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      },
```

- [ ] **Step 10: Use STS in the resolver**

Replace `backend/src/sync/cloud-client-resolver.ts` with:

```ts
import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { CLOUD_CLIENT, CloudClient, Ec2CloudClient } from './cloud-client.js';
import { assumeRole } from './sts.js';

/** Selects a cloud client for a group: connected AWS account (static or STS) or the default Floci/stub client. */
@Injectable()
export class CloudClientResolver {
  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
    @Inject(CLOUD_CLIENT) private readonly defaultClient: CloudClient,
  ) {}

  async forAccount(awsAccountId: string | null | undefined): Promise<CloudClient> {
    if (!awsAccountId || this.config.get<string>('SYNC_MODE') === 'stub') return this.defaultClient;
    const account = await this.prisma.awsAccount.findUnique({ where: { id: awsAccountId } });
    if (!account) throw new NotFoundException('Akun AWS tidak ditemukan.');
    if (!this.crypto.isConfigured()) {
      throw new ServiceUnavailableException('Enkripsi belum dikonfigurasi (CREDENTIAL_ENCRYPTION_KEYS).');
    }
    const region = account.region;
    let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    if (account.roleArn) {
      credentials = await assumeRole({
        region,
        roleArn: account.roleArn,
        ...(account.externalIdEnc ? { externalId: this.crypto.decrypt(account.externalIdEnc) } : {}),
        sessionDuration: account.sessionDuration,
      });
    } else {
      credentials = {
        accessKeyId: this.crypto.decrypt(account.accessKeyIdEnc),
        secretAccessKey: this.crypto.decrypt(account.secretAccessKeyEnc),
      };
    }
    return new Ec2CloudClient({ region, ...credentials });
  }
}
```

- [ ] **Step 11: Add a resolver test for session-token propagation**

Create `backend/src/sync/cloud-client-resolver.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const { assumeRole, ec2Options } = vi.hoisted(() => ({
  assumeRole: vi.fn(),
  ec2Options: [] as unknown[],
}));
vi.mock('./sts.js', () => ({ assumeRole }));
vi.mock('./cloud-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cloud-client.js')>();
  return {
    ...actual,
    Ec2CloudClient: class {
      constructor(options: unknown) {
        ec2Options.push(options);
      }
    },
  };
});

import { CloudClientResolver } from './cloud-client-resolver.js';

describe('CloudClientResolver', () => {
  it('passes temporary STS credentials including the session token', async () => {
    assumeRole.mockResolvedValueOnce({
      accessKeyId: 'TEMP',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    const resolver = new CloudClientResolver(
      { get: () => undefined } as never,
      { isConfigured: () => true, decrypt: (v: string) => v } as never,
      {
        awsAccount: {
          findUnique: async () => ({
            region: 'ap-southeast-1',
            roleArn: 'arn:aws:iam::123456789012:role/r',
            externalIdEnc: null,
            sessionDuration: 3600,
            accessKeyIdEnc: 'a',
            secretAccessKeyEnc: 'b',
          }),
        },
      } as never,
      {} as never,
    );
    await resolver.forAccount('account-id');
    expect(assumeRole).toHaveBeenCalledWith({
      region: 'ap-southeast-1',
      roleArn: 'arn:aws:iam::123456789012:role/r',
      sessionDuration: 3600,
    });
    expect(ec2Options.at(-1)).toMatchObject({ sessionToken: 'token', accessKeyId: 'TEMP' });
  });
});
```

- [ ] **Step 12: Verify build and commit**

Run: `cd backend && pnpm build && pnpm test`
Expected: PASS.

```bash
git add backend/prisma backend/src/sync backend/src/aws-accounts backend/package.json backend/pnpm-lock.yaml
git commit -m "feat: support STS AssumeRole credentials for AWS accounts"
```

---

## Task 5: Allow changing a group's AWS account after creation

**Files:**
- Modify: `backend/src/groups/groups.service.ts:1-20,91-104`
- Modify: `backend/src/groups/dto/group.dto.ts:24`
- Test: `backend/src/groups/groups.service.spec.ts`

**Interfaces:**
- Consumes: `prisma.securityGroup.update`, `sync.ensureGroup(id)`, `access.require(userId, id, 'OWNER')`, `SyncStatus.PENDING`.
- Produces: `GroupsService.update` now accepts `awsAccountId?: string | null`.

- [ ] **Step 1: Write the failing update test**

Create `backend/src/groups/groups.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GroupsService } from './groups.service.js';

function setup(accountFound: unknown) {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'g1', ...args.data }));
  const ensureGroup = vi.fn(async () => undefined);
  const findOne = vi.fn(async () => ({ id: 'g1' }));
  const service = new GroupsService(
    {
      securityGroup: { update, findUniqueOrThrow: vi.fn() },
      awsAccount: { findFirst: vi.fn(async () => accountFound) },
    } as never,
    { require: vi.fn(async () => 'OWNER') } as never,
    { ensureGroup } as never,
  ) as GroupsService & { findOne: typeof findOne };
  service.findOne = findOne;
  return { service, update, ensureGroup };
}

describe('GroupsService.update', () => {
  it('resets cloud state and resyncs when the AWS account changes', async () => {
    const { service, update, ensureGroup } = setup({ id: 'account-2' });
    await service.update('u1', 'g1', { awsAccountId: 'account-2' });
    expect(update.mock.calls[0][0].data).toMatchObject({
      awsAccountId: 'account-2',
      flociGroupId: null,
      syncStatus: 'PENDING',
      syncError: null,
    });
    expect(ensureGroup).toHaveBeenCalledWith('g1');
  });

  it('allows unassigning the account with null', async () => {
    const { service, update } = setup(null);
    await service.update('u1', 'g1', { awsAccountId: null });
    expect(update.mock.calls[0][0].data).toMatchObject({ awsAccountId: null, flociGroupId: null });
  });

  it('rejects an account the user does not own', async () => {
    const { service, update, ensureGroup } = setup(null);
    await expect(service.update('u1', 'g1', { awsAccountId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    expect(ensureGroup).not.toHaveBeenCalled();
  });
});
```

The constructor is exactly `(prisma, access, @Inject(SYNC_PORT) sync)` in `groups.service.ts`; no other dependencies are needed.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm exec vitest run src/groups/groups.service.spec.ts`
Expected: FAIL — update still throws `BadRequestException`.

- [ ] **Step 3: Implement the account change**

In `backend/src/groups/groups.service.ts`:
- Add `import { SyncStatus } from '@prisma/client';` if not already present.
- Replace `update` (lines 91–104) with:

```ts
  async update(userId: string, id: string, dto: UpdateGroupDto) {
    await this.access.require(userId, id, 'OWNER');
    let accountChanged = false;
    if (dto.awsAccountId !== undefined) {
      if (dto.awsAccountId !== null) {
        const account = await this.prisma.awsAccount.findFirst({
          where: { id: dto.awsAccountId, userId },
        });
        if (!account) throw new NotFoundException('Akun AWS tidak ditemukan.');
      }
      accountChanged = true;
    }
    const updated = await this.prisma.securityGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(accountChanged
          ? {
              awsAccountId: dto.awsAccountId ?? null,
              flociGroupId: null,
              syncStatus: SyncStatus.PENDING,
              syncError: null,
            }
          : {}),
      },
    });
    if (accountChanged) await this.sync.ensureGroup(updated.id);
    return this.findOne(userId, id);
  }
```

- If oxlint reports an unused `BadRequestException` import, remove it; keep `NotFoundException` (already used by `create`).

- [ ] **Step 4: Make the DTO's null intent explicit**

In `backend/src/groups/dto/group.dto.ts`, replace `export class UpdateGroupDto extends PartialType(CreateGroupDto) {}` with:

```ts
/** `awsAccountId: null` melepaskan akun AWS dan memakai kembali Floci/stub. */
export class UpdateGroupDto extends PartialType(CreateGroupDto) {
  @IsOptional()
  @IsUUID('all', { message: 'awsAccountId tidak valid' })
  override awsAccountId?: string | null;
}
```

`@IsOptional()` skips `null`, so unassignment validates successfully.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/groups/groups.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify build and commit**

Run: `cd backend && pnpm build && pnpm test`
Expected: PASS.

```bash
git add backend/src/groups
git commit -m "feat: allow reassigning a security group's AWS account"
```

---

## Task 6: Guided real-integration verification script

**Files:**
- Create: `backend/scripts/verify-integrations.js`
- Modify: `README.md` (append "Verifying real integrations" section)

**Interfaces:**
- Consumes: env vars `FLOCI_URL` / `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `SLACK_WEBHOOK_URL`, `SMTP_HOST` / `SMTP_PORT` / `MAIL_FROM` / `VERIFY_EMAIL_TO`.
- Produces: exit code 0 when all configured checks pass, 1 otherwise; no secret values in output.

- [ ] **Step 1: Write the script**

Create `backend/scripts/verify-integrations.js`:

```js
#!/usr/bin/env node
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import * as nodemailer from 'nodemailer';

const results = [];

async function checkAws() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { name: 'AWS/Floci', status: 'SKIP', detail: 'kredensial tidak diset' };
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = new EC2Client({
    region,
    ...(process.env.FLOCI_URL ? { endpoint: process.env.FLOCI_URL } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const res = await client.send(new DescribeRegionsCommand({}));
  if (!res.Regions?.length) throw new Error('tidak ada region yang dikembalikan');
  return { name: 'AWS/Floci', status: 'PASS', detail: `${res.Regions.length} region terlihat` };
}

async function checkSlack() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { name: 'Slack', status: 'SKIP', detail: 'SLACK_WEBHOOK_URL tidak diset' };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'SGuard integration check' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { name: 'Slack', status: 'PASS', detail: 'pesan uji terkirim' };
}

async function checkSmtp() {
  const to = process.env.VERIFY_EMAIL_TO;
  if (!to) return { name: 'SMTP/Mailpit', status: 'SKIP', detail: 'VERIFY_EMAIL_TO tidak diset' };
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || 'SGuard <noreply@sguard.local>',
    to,
    subject: 'SGuard integration check',
    text: 'Integration check from verify-integrations.js',
  });
  return { name: 'SMTP/Mailpit', status: 'PASS', detail: 'email uji terkirim' };
}

const checks = [checkAws, checkSlack, checkSmtp];
const labels = ['AWS/Floci', 'Slack', 'SMTP/Mailpit'];
for (let i = 0; i < checks.length; i += 1) {
  try {
    results.push(await checks[i]());
  } catch (err) {
    results.push({ name: labels[i], status: 'FAIL', detail: String(err?.message ?? err).slice(0, 200) });
  }
}

for (const result of results) {
  console.log(`${result.status.padEnd(4)}  ${result.name}: ${result.detail}`);
}
const failed = results.some((r) => r.status === 'FAIL');
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${results.filter((r) => r.status === 'FAIL').length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped.`);
process.exit(failed ? 1 : 0);
```

Run: `cd backend && node --check scripts/verify-integrations.js`
Expected: no syntax errors. Do **not** execute the script against real services.

- [ ] **Step 2: Document the script in README**

Append to `README.md`:

```markdown
## Verifying real integrations

The unit and e2e suites use Floci and mocks. To check real services from your own
environment, set the relevant variables and run:

```bash
cd backend
node --env-file=.env scripts/verify-integrations.js
```

| Check | Variables | Skipped when |
| --- | --- | --- |
| AWS / Floci | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_REGION`, `FLOCI_URL` | credentials unset |
| Slack | `SLACK_WEBHOOK_URL` | variable unset |
| SMTP / Mailpit | `VERIFY_EMAIL_TO`, optional `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` | `VERIFY_EMAIL_TO` unset |

The script prints a PASS/FAIL/SKIP summary and exits non-zero if any check fails.
It never prints secret values. The assistant does not run this script; you run it
where the credentials live.
```

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/verify-integrations.js README.md
git commit -m "docs: add guided real-integration verification script"
```

---

## Task 7: Full Docker Compose stack, health endpoint, deployment docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/src/app.module.ts`
- Create: `backend/src/health/health.controller.ts`
- Create: `backend/src/health/health.module.ts`
- Create: `backend/src/health/prisma.health.ts`
- Create: `backend/src/health/redis.health.ts`
- Test: `backend/src/health/health.controller.spec.ts`
- Modify: `backend/package.json` (add `@nestjs/terminus`)
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `HealthCheckService`, `@nestjs/terminus`; `REDIS_CLIENT` from Task 1; `PrismaService`.
- Produces: `GET /health` returning `{ status, info, error, details }`.

- [ ] **Step 1: Install terminus**

Run: `cd backend && pnpm add @nestjs/terminus`
Expected: dependency added; stop on network failure.

- [ ] **Step 2: Write the failing health-controller test**

Create `backend/src/health/health.controller.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns the terminus health result', async () => {
    const result = { status: 'ok', info: { database: { status: 'up' } }, error: {}, details: {} };
    const controller = new HealthController({ check: vi.fn(async () => result) } as never);
    await expect(controller.check()).resolves.toEqual(result);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && pnpm exec vitest run src/health/health.controller.spec.ts`
Expected: FAIL — controller missing.

- [ ] **Step 4: Implement the indicators and controller**

Create `backend/src/health/prisma.health.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { HealthCheckResult, HealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthCheckResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.getStatus(key, true);
    } catch (err) {
      return this.getStatus(key, false, { message: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
}
```

Create `backend/src/health/redis.health.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { HealthCheckResult, HealthIndicator } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/rate-limit-store.js';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {
    super();
  }

  async isHealthy(key: string): Promise<HealthCheckResult> {
    if (!this.redis) return this.getStatus(key, true, { note: 'REDIS_URL belum diset; mode memori' });
    try {
      const pong = await this.redis.ping();
      return this.getStatus(key, pong === 'PONG');
    } catch (err) {
      return this.getStatus(key, false, { message: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
}
```

Create `backend/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health.js';
import { RedisHealthIndicator } from './redis.health.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
```

Create `backend/src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { PrismaHealthIndicator } from './prisma.health.js';
import { RedisHealthIndicator } from './redis.health.js';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
```

- [ ] **Step 5: Run the health test to verify it passes**

Run: `cd backend && pnpm exec vitest run src/health/health.controller.spec.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Register the module**

In `backend/src/app.module.ts`, add `import { HealthModule } from './health/health.module.js';` and add `HealthModule` to `imports` after `RateLimitModule`.

- [ ] **Step 7: Extend docker-compose.yml**

Replace `docker-compose.yml` with:

```yaml
name: sguard

services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-sguard}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-sguard}
      POSTGRES_DB: ${POSTGRES_DB:-sguard}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-sguard} -d ${POSTGRES_DB:-sguard}"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  floci:
    image: ${FLOCI_IMAGE:-floci/floci:latest}
    restart: unless-stopped
    ports:
      - "4566:4566"
    volumes:
      - ./data/floci:/app/data

  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    ports:
      - "1025:1025"
      - "8025:8025"

  backend:
    build: ./backend
    restart: unless-stopped
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgresql://${POSTGRES_USER:-sguard}:${POSTGRES_PASSWORD:-sguard}@postgres:5432/${POSTGRES_DB:-sguard}
    ports:
      - "4000:4000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  frontend:
    build: ./frontend
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      backend:
        condition: service_started

volumes:
  pgdata:
```

- [ ] **Step 8: Complete .env.example**

Replace `.env.example` with the complete example (all keys below are read by `backend/src`):

```dotenv
# Docker Compose defaults
POSTGRES_USER=sguard
POSTGRES_PASSWORD=sguard
POSTGRES_DB=sguard
FLOCI_IMAGE=floci/floci:latest

# Application runtime
DATABASE_URL=postgresql://sguard:sguard@localhost:5432/sguard
JWT_SECRET=change-me
JWT_EXPIRES_IN=15m
SYNC_MODE=stub
SYNC_TRANSPORT=local
EMAIL_VERIFICATION=false
MAIL_TRANSPORT=log
MAIL_FROM=SGuard <noreply@sguard.local>
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
FRONTEND_ORIGIN=http://localhost:3000

# Shared rate limiting (empty = in-memory fallback)
REDIS_URL=redis://localhost:6379

# Credential encryption / rotation
# CREDENTIAL_ENCRYPTION_KEY=<legacy base64 32-byte key, exposed as id "default">
CREDENTIAL_ENCRYPTION_KEYS=
CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=k2

# Optional integrations
# ALLOW_INSECURE_WEBHOOKS=false
# ALLOW_PRIVATE_WEBHOOKS=false
# SLACK_WEBHOOK_HOST=hooks.slack.com
# AWS_REGION=ap-southeast-1
# FLOCI_ENDPOINT=http://localhost:4566
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# SCAN_INTERVAL_MINUTES=5
# SYNC_WORKER_HOST=127.0.0.1
# SYNC_WORKER_PORT=4000
# GITHUB_API_BASE=https://api.github.com
# GITHUB_OAUTH_BASE=https://github.com
# GITHUB_CALLBACK_URL=http://localhost:4000/auth/github/callback
```

- [ ] **Step 9: Document deployment**

Append to `README.md`:

```markdown
## Local deployment (Docker Compose)

```bash
cp .env.example .env
# Edit .env: set JWT_SECRET and, for real AWS, the credentials/rotation variables.
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:4000 |
| Health check | http://localhost:4000/health |
| Mailpit UI | http://localhost:8025 |
| Floci | http://localhost:4566 |

`GET /health` reports database and Redis status. When `REDIS_URL` is unset the
backend falls back to in-memory rate limiting and health reports redis as up
with a note. `docker compose down` stops the stack; data persists in the
`pgdata` volume.
```

- [ ] **Step 10: Validate compose and run full checks**

Run:
```bash
cd /home/nirmala/Documents/Github/sguard && docker compose config >/dev/null && echo "compose OK"
cd backend && pnpm build && pnpm test
```
Expected: compose config parses; build and tests pass.

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml .env.example README.md backend/package.json backend/pnpm-lock.yaml backend/src/app.module.ts backend/src/health
git commit -m "feat: complete Docker Compose stack with health endpoint and deployment docs"
```

---

## Final verification (after all tasks)

Run once, after reconciling all task outputs:

```bash
cd backend && pnpm build && pnpm test && pnpm exec vitest run --config ./vitest.config.e2e.ts
cd /home/nirmala/Documents/Github/sguard && docker compose config >/dev/null && echo "compose OK"
```

The Floci e2e suite remains gated by `FLOCI_TEST=1`; report it as skipped, not failed. Real AWS/Slack/SMTP checks are deliberately not executed. Confirm `git status --short` shows no unintended files (`.ua/` is intentionally untracked).
