import { createHash, randomBytes } from 'node:crypto';

/** Refresh token berlaku 7 hari (PRD bagian 6). */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Token acak panjang; yang disimpan di database hanya hash-nya. */
export function newRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
