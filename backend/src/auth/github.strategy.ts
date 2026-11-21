import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { GithubProfile } from './auth.service';

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Strategi GitHub OAuth (FR-21). Tanpa GITHUB_CLIENT_ID, strategi tetap terdaftar dengan nilai
 * placeholder, tetapi rute /auth/github ditolak 404 oleh GithubAuthGuard.
 *
 * GITHUB_OAUTH_BASE dan GITHUB_API_BASE default ke github.com dan api.github.com. Keduanya bisa
 * diarahkan ke server tiruan untuk pengujian protokol; produksi tidak mengubahnya.
 */
@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  private readonly logger = new Logger(GithubStrategy.name);
  private readonly apiBase: string;

  constructor(config: ConfigService) {
    const oauthBase = (config.get<string>('GITHUB_OAUTH_BASE') ?? 'https://github.com').replace(/\/$/, '');
    const apiBase = (config.get<string>('GITHUB_API_BASE') ?? 'https://api.github.com').replace(/\/$/, '');
    super({
      clientID: config.get<string>('GITHUB_CLIENT_ID') || 'disabled',
      clientSecret: config.get<string>('GITHUB_CLIENT_SECRET') || 'disabled',
      callbackURL: config.get<string>('GITHUB_CALLBACK_URL') ?? 'http://localhost:4000/auth/github/callback',
      scope: ['user:email'],
      authorizationURL: `${oauthBase}/login/oauth/authorize`,
      tokenURL: `${oauthBase}/login/oauth/access_token`,
      userProfileURL: `${apiBase}/user`,
      userEmailURL: `${apiBase}/user/emails`,
    });
    this.apiBase = apiBase;
  }

  async validate(accessToken: string, _refreshToken: string, profile: Profile): Promise<GithubProfile> {
    return {
      githubId: String(profile.id),
      email: await this.verifiedEmail(accessToken),
      name: profile.displayName || profile.username || 'GitHub user',
    };
  }

  /** Email utama yang sudah diverifikasi GitHub. Email privat tidak ikut di profil, jadi diambil terpisah. */
  private async verifiedEmail(accessToken: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiBase}/user/emails`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const emails = (await res.json()) as GithubEmail[];
      const chosen = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      return chosen?.email ?? null;
    } catch (err) {
      this.logger.warn(`Gagal mengambil email GitHub: ${String((err as Error)?.message ?? err)}`);
      return null;
    }
  }
}
