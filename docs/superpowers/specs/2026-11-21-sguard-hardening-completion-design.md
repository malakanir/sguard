# SGuard — Hardening & Completion Pass (Design Spec)

**Date:** 2026-11-21
**Status:** Design approved by user; awaiting spec review, then implementation plan
**Scope:** Close the six remaining gaps documented in `README.md` (lines 90, 120–127, 143, 153)
**Output language:** English (all docs, summaries, code comments)

---

## 1. Context and Goals

SGuard is a Next.js + NestJS web app for managing, auditing and simulating AWS security-group rules. It persists to PostgreSQL and syncs to Floci (a local AWS emulator). The README declares layers 1/2/3 and phases 2/3 "selesai" (done), but explicitly lists six items that are not yet production-grade or not yet shipped. The user asked to implement **all six**.

**Success criteria:**
1. Rate-limit state survives multiple backend instances and process restarts via Redis, with no change to existing failed-login semantics.
2. Credential encryption supports key rotation through a pluggable `KeyProvider`, without changing any `encrypt`/`decrypt` caller signatures and without requiring a KMS/Vault service.
3. Outbound webhook delivery is immune to DNS rebinding by pinning the HTTP connection to validated addresses, revalidated on every delivery.
4. AWS accounts can use STS `AssumeRole`, and a security group's AWS account can be changed after creation (with full state reset + resync).
5. A guided script verifies real AWS/Floci, Slack and SMTP integrations using credentials supplied by the user's own environment; no credentials are required from the user now.
6. A single `docker compose up` brings up Postgres, Redis, Floci, Mailpit, backend and frontend, with a `/health` endpoint and deployment docs.

**Non-goals:**
- No KMS/Vault integration (Floci is not a KMS; only a local EC2 emulator). Abstraction only.
- No change to report-export scoping (own data only — by design, not a gap).
- No real-service verification executed by the assistant; scripts + docs only.
- No change to the knowledge-graph tooling or `.ua/` artifacts.

---

## 2. Project Constraints (authoritative `AGENTS.md`)

- NestJS ESM only: relative imports end in `.js`; use `import.meta.dirname`.
- Tests: **Vitest** with `vi.fn()`, never `jest.fn()`.
- Prefer first-party Nest packages over third-party libs (`@nestjs/throttler`, `@nestjs/terminus`, `@nestjs/cache-manager`, `@nestjs/idempotency`, `@nestjs/webhooks`, `@nestjs/platform-node` `NodeAdapter`, `@nestjs/skills`).
- Validation via `StandardSchemaValidationPipe` or `ValidationPipe` + `class-validator`.
- Nest docs: `https://docs.nestjs.com/llms.txt` (chapter `.md` pages redirect to the oversized `llms-full.txt`).

---

## 3. Current State (verified code map)

| File | Current behavior |
|---|---|
| `backend/src/common/rate-limit.ts` | `RateLimiter` class, in-memory `Map`, `check` / `recordFailure` / `reset`, prune at 10k entries. Used only by `auth/auth.service.ts` for failed logins; successful login resets the counter. |
| `backend/src/common/crypto.service.ts` | AES-256-GCM, single `CREDENTIAL_ENCRYPTION_KEY` (base64, 32 bytes), format `v1:iv:tag:data`, `isConfigured` / `encrypt` / `decrypt` / `requireKey`, exported via `@Global CryptoModule`. |
| `backend/src/notifications/url-guard.ts` | `assertSafeWebhookUrl(raw, options)` resolves DNS **only at validation time**; `PRIVATE_RANGES` list; comment already notes DNS rebinding needs HTTP-layer pinning. |
| `backend/src/notifications/notifications.service.ts` | `deliverWebhook` (≈:140–164) calls `assertSafe` then `postJson` using global `fetch` with `redirect: 'error'` and `AbortSignal.timeout`; `validateTarget` ≈:177–188. |
| `backend/src/sync/cloud-client.ts` | `CloudClient` interface; `Ec2Options { region, endpoint?, accessKeyId, secretAccessKey }`; `Ec2CloudClient` wraps AWS SDK `EC2Client` with static credentials; `CLOUD_CLIENT` DI symbol. |
| `backend/src/sync/cloud-client-resolver.ts` | `forAccount(awsAccountId)` returns default client when null/stub, else `Ec2CloudClient` with `crypto.decrypt` of both keys. |
| `backend/src/aws-accounts/aws-accounts.service.ts` | `create` stores encrypted keys; `test()` calls `resolver.verify()`; `remove` blocked while groups use the account; `toView` shows last 4 chars of access key. |
| `backend/src/groups/groups.service.ts` | `create` (≈:52–68) validates `awsAccountId` ownership; `update` (≈:91–104) throws `BadRequestException('Akun AWS tidak dapat diubah setelah group dibuat.')`. |
| `backend/prisma/schema.prisma` | `SecurityGroup.awsAccountId String? @db.Uuid` with `onDelete: SetNull`; `AwsAccount { id, userId, name, region, accessKeyIdEnc, secretAccessKeyEnc, lastVerifiedAt, lastVerifyError, createdAt }`. |
| `backend/src/app.module.ts` | Imports `ConfigModule`, `EventEmitterModule`, `ScheduleModule`, all feature modules and `CryptoModule`. |
| `backend/package.json` | NestJS ^12, Prisma ^6.19.3, `@aws-sdk/client-ec2` ^3.1164, Vitest ^4. No throttler/redis/sts/terminus deps yet. |
| `docker-compose.yml` | Only `postgres:15-alpine` (healthcheck), `floci`, `mailpit`. No redis/backend/frontend services. |
| `.env.example` | Only `POSTGRES_*` and `FLOCI_IMAGE`. |

---

## 4. Change 1 — Distributed rate-limit store

**Approach chosen:** (A) Extract an async store interface; keep the current in-memory implementation as the default when `REDIS_URL` is empty. (B) `@nestjs/throttler` + Redis storage was considered and rejected because `skipSuccessfulRequests` does not reset an old counter, which would change failed-login semantics.

**Design:**
- New `backend/src/common/rate-limit-store.ts`:
  ```ts
  export interface RateLimitStore {
    check(key: string): Promise<boolean>;
    recordFailure(key: string): Promise<void>;
    reset(key: string): Promise<void>;
  }
  ```
  Keep the existing `RateLimiter` public shape (`check`, `recordFailure`, `reset`, prune threshold 10k) as `MemoryRateLimitStore`.
- `RedisRateLimitStore` uses the `ioredis` client with atomic `INCR` + `EXPIRE` (pipeline or small Lua script) so the counter and TTL are set together. Counter TTL must match the existing lockout window exactly (read its current value from `rate-limit.ts` during implementation; do not invent a new duration).
- Store selection in a `@Global` `RateLimitModule` (or factory provider) driven by `ConfigService.get('REDIS_URL')`: empty → memory, non-empty → Redis. `AuthService` injects `RateLimitStore` instead of the concrete class; its logic (failed login increments, successful login resets) is byte-for-byte unchanged.
- `REDIS_URL` added to `.env.example` and to docker-compose (see Change 6).

**Compatibility:** No HTTP contract change. Existing unit tests for login throttling must still pass with the memory store. New tests cover the selector, Redis atomicity (mocked client) and reset-on-success.

---

## 5. Change 2 — KeyProvider abstraction for rotation

**Decision:** Floci is *not* a KMS — it only emulates EC2. Build a local `KeyProvider` abstraction now; no KMS/Vault dependency.

**Design:**
- New `backend/src/common/key-provider.ts`:
  ```ts
  export interface KeyProvider {
    activeKeyId(): string;
    getKey(keyId: string): Promise<Buffer> | Buffer;
    listKeyIds(): string[];
  }
  ```
- `EnvKeyProvider`: parses `CREDENTIAL_ENCRYPTION_KEYS` as a JSON object `{ [keyId: string]: base64Key }`; `activeKeyId()` from `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID` (default: first entry); legacy `CREDENTIAL_ENCRYPTION_KEY` is exposed as key id `"default"` so existing installations keep working.
- `CryptoService.encrypt` produces `v2:<keyId>:<iv>:<tag>:<data>` using `activeKeyId()`; `decrypt` keeps `v1:...` compatibility and uses the key id embedded in `v2` records. `isConfigured` / `requireKey` delegate to the provider. **Public method signatures do not change**, so every consumer (`aws-accounts.service.ts`, `cloud-client-resolver.ts`, etc.) is untouched.
- `CryptoModule` provides `KeyProvider` via `EnvKeyProvider`.
- `.env.example` documents both the legacy key and the new rotation variables.

**Verification:** Vitest tests: encrypt→decrypt with v2; decrypt of a known v1 fixture; rotation where old ciphertext still decrypts after `activeKeyId()` changes; `requireKey` throws when no key is configured.

---

## 6. Change 3 — Webhook DNS-rebinding protection

**Design:**
- `assertSafeWebhookUrl(raw, options)` changes its return type from `URL` to `{ url: URL; addresses: string[] }`. It resolves DNS **and returns the validated addresses**; `PRIVATE_RANGES` checks remain.
- Add `pinnedFetch` in `backend/src/notifications/` built on `node:http` / `node:https` with a custom `lookup` function that returns only the pre-validated addresses. Preserve current behavior: `redirect: 'error'`, `AbortSignal.timeout`, method/headers/body.
- `deliverWebhook` (≈:140–164) calls `assertSafeWebhookUrl` and then `pinnedFetch(...)` with the returned addresses. `validateTarget` (≈:177–188) is updated for the new return type. Revalidation happens on **every delivery**, not just at config time.
- Every caller of `assertSafeWebhookUrl` is updated for the new return shape (search all call sites during implementation).

**Verification:** Vitest test with a local HTTP server and a hostname mapped to `127.0.0.1`; assert that a rebinding response (A record changing between validation and connect) is rejected; assert private-range URLs are still rejected; assert timeout and redirect rejection still work.

---

## 7. Change 4 — STS AssumeRole + per-group AWS account changes

**Design:**
- **Prisma migration** on `AwsAccount`:
  - `roleArn String?`
  - `externalIdEnc String?` (encrypted with the same `CryptoService`)
  - `sessionDuration Int @default(3600)`
- **DTOs** (`aws-accounts` create/update) extended with `class-validator` decorators for the new optional fields; `roleArn` validated as an ARN shape, `sessionDuration` within STS bounds (900–43200).
- `Ec2Options` gains `sessionToken?: string`; `Ec2CloudClient` passes it to `EC2Client`.
- `CloudClientResolver.forAccount(awsAccountId)`: when `roleArn` is set, call `@aws-sdk/client-sts` `AssumeRoleCommand` (with `RoleArn`, `RoleSessionName`, optional `ExternalId`, `DurationSeconds`), decrypt `externalIdEnc`, and pass `AccessKeyId`, `SecretAccessKey`, `SessionToken` from the assumed credentials into `Ec2CloudClient`. Fall back to static keys when `roleArn` is absent. `verify()` exercises the assume-role path so `aws-accounts.service.test()` validates it.
- `groups.service.update`: remove the hard rejection at ≈:91–104. Allow `awsAccountId` (including `null` to unassign). Validate ownership via the existing check used in `create`. On change set `flociGroupId = null`, `syncStatus = PENDING`, `syncError = null`, save, then call `sync.ensureGroup()` so the group is recreated on the target account/Floci.

**Verification:** Vitest with `vi.fn()` mocks for `STSClient.send` and `EC2Client` construction; assert session token propagation, no STS call when `roleArn` is absent, and group update state reset. Apply the Prisma migration locally before e2e.

---

## 8. Change 5 — Real-service verification script

**Design:**
- `backend/scripts/verify-integrations.js` (ESM, `.js` extension per AGENTS.md):
  - Reads credentials/endpoints from env (`FLOCI_URL`, `AWS_*`, `SLACK_WEBHOOK_URL`, `SMTP_*`, etc.).
  - Three checks: (a) AWS/Floci — call a harmless EC2 read through the existing `CloudClient`; (b) Slack — POST a test message to the configured webhook; (c) SMTP/Mailpit — send a test email via the configured transport.
  - Prints a PASS/FAIL summary with exit code 1 on any failure. **Never prints secret values.**
- README gets a "Verifying real integrations" section documenting required env vars and how to run the script. The assistant does **not** execute it; the user runs it in their own environment.

**Verification:** Script is syntax-checked (`node --check`) and covered by docs review; no real network calls in CI.

---

## 9. Change 6 — Full local deployment via Docker Compose

**Design:**
- `docker-compose.yml` additions:
  - `redis:7-alpine` with healthcheck.
  - `backend` service built from `backend/Dockerfile`, `env_file: .env`, `depends_on` with healthcheck conditions for postgres/redis/floci, port `4000`.
  - `frontend` service built from `frontend/Dockerfile`, `env_file: .env`, `depends_on` backend, port `3000`.
  - `REDIS_URL` wired into backend env.
- `GET /health` endpoint using `@nestjs/terminus` with a **custom Prisma health indicator** (since the project uses Prisma, not TypeORM) and a custom Redis ping indicator; registered in `app.module.ts` via `TerminusModule`.
- `.env.example` updated with Redis, rate-limit, encryption-key-rotation, STS-related and frontend/backend vars.
- README "Deployment" section: copy `.env.example` → `.env`, fill values, `docker compose up -d`, open `http://localhost:3000`, check `http://localhost:4000/health`.

**Verification:** `docker compose config` parses cleanly; `GET /health` returns 200 when dependencies are healthy (manual/local). Unit tests for the health controller with mocked indicators.

---

## 10. Cross-cutting verification plan

1. Add/extend Vitest tests for: rate-limit store selector + memory semantics; key rotation + v1 compatibility; webhook address pinning; STS-mocked resolver + session token; group account-change state reset.
2. `backend`: `pnpm build`, `pnpm test`, `pnpm test:e2e` (Floci e2e remains gated by `FLOCI_TEST=1`).
3. `frontend`: lint/build as defined by its package scripts.
4. `docker compose config` validation.
5. Apply the Prisma migration locally before e2e; confirm generate succeeds.

**Risks:**
- Installing new dependencies (`ioredis`, `@aws-sdk/client-sts`, `@nestjs/terminus`, possibly `@nestjs/throttler`) requires network access; if unavailable, report and stop rather than hand-rolling.
- Prisma migration must be applied and generated before code referencing new fields compiles.
- Terminus health indicators must match the actual Prisma/Redis setup (no TypeORM); use a custom `HealthIndicator` for Prisma `$queryRaw` and a Redis ping indicator.

---

## 11. Rollout / sequencing

Phase A (backend core): Changes 1, 2, 5 (store, key provider, verification script).
Phase B (network/security): Changes 3, 4 (pinning, STS + group account change).
Phase C (delivery): Change 6 (compose, health, docs).
Each phase ends with its focused tests; full build/test/e2e runs after reconciliation, before final handoff.
