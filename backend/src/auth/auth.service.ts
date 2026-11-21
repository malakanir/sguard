import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RATE_LIMIT_STORE, RateLimitStore } from '../common/rate-limit-store.js';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { MAIL_SENDER, MailSender } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { JwtPayload } from './jwt.strategy';
import { hashToken, newRefreshToken, REFRESH_TOKEN_TTL_MS } from './tokens';

const BCRYPT_ROUNDS = 10;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface GithubProfile {
  githubId: string;
  email: string | null;
  name: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    /** Maksimal 5 percobaan gagal per 15 menit untuk satu kombinasi IP dan email (FR-25). */
    @Inject(RATE_LIMIT_STORE) private readonly loginLimiter: RateLimitStore,
  ) {}

  /** Flag EMAIL_VERIFICATION, nonaktif secara default (PRD bagian 6). */
  emailVerificationEnabled(): boolean {
    return this.config.get<string>('EMAIL_VERIFICATION') === 'true';
  }

  githubEnabled(): boolean {
    return Boolean(this.config.get<string>('GITHUB_CLIENT_ID'));
  }

  publicConfig() {
    return { emailVerification: this.emailVerificationEnabled(), github: this.githubEnabled() };
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email sudah terdaftar.');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { name: dto.name, email, passwordHash },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    if (this.emailVerificationEnabled()) {
      await this.sendVerification(user.id, user.email);
      return { ...user, emailVerificationRequired: true };
    }
    return user;
  }

  async login(dto: LoginDto, ip = 'unknown') {
    const email = dto.email.toLowerCase();
    const key = `${ip}|${email}`;
    const gate = await this.loginLimiter.check(key);
    if (!gate.allowed) {
      throw new HttpException(
        `Terlalu banyak percobaan login. Coba lagi dalam ${Math.ceil(gate.retryAfterSec / 60)} menit.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Pesan sama untuk email tidak ada dan password salah, supaya tidak membocorkan akun.
    if (!user?.passwordHash || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      await this.loginLimiter.recordFailure(key);
      throw new UnauthorizedException('Email atau password salah.');
    }
    await this.loginLimiter.reset(key);
    if (this.emailVerificationEnabled() && !user.emailVerifiedAt) {
      throw new ForbiddenException('Email belum diverifikasi. Cek kotak masuk Anda.');
    }
    return this.issueTokens(user.id, user.email, user.role, user.name);
  }

  /** Tukar refresh token dengan pasangan baru. Token lama langsung tidak berlaku (rotasi). */
  async refresh(refreshToken: string) {
    const user = await this.prisma.user.findFirst({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });
    if (!user || !user.refreshTokenExpiresAt || user.refreshTokenExpiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token tidak valid atau sudah kedaluwarsa.');
    }
    return this.issueTokens(user.id, user.email, user.role, user.name);
  }

  /** Cabut refresh token. Access token yang sudah terbit tetap berlaku sampai kedaluwarsa (15 menit). */
  async logout(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
    });
  }

  async me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
  }

  /** Verifikasi email lewat tautan. Token disimpan sebagai hash dan hanya bisa dipakai sekali. */
  async verifyEmail(rawToken: string) {
    const record = await this.prisma.emailVerificationToken.findFirst({
      where: { tokenHash: hashToken(rawToken), usedAt: null },
    });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Link verifikasi tidak valid atau sudah kedaluwarsa.');
    }
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    return { verified: true };
  }

  /**
   * Login atau daftar lewat GitHub. Akun dicocokkan lewat github_id. Jika email GitHub sudah
   * dipakai akun lain, akun itu hanya dihubungkan bila email-nya sudah terverifikasi di SGuard.
   */
  async loginWithGithub(profile: GithubProfile) {
    let user = await this.prisma.user.findUnique({ where: { githubId: profile.githubId } });
    if (!user) {
      if (!profile.email) {
        throw new BadRequestException('Akun GitHub tidak punya email. Tambahkan email di GitHub lalu coba lagi.');
      }
      const email = profile.email.toLowerCase();
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        if (!existing.emailVerifiedAt) {
          throw new ConflictException(
            'Email ini sudah terdaftar dan belum diverifikasi. Verifikasi email dulu, lalu login dengan GitHub.',
          );
        }
        user = await this.prisma.user.update({ where: { id: existing.id }, data: { githubId: profile.githubId } });
      } else {
        user = await this.prisma.user.create({
          data: { name: profile.name, email, githubId: profile.githubId, emailVerifiedAt: new Date() },
        });
      }
    }
    return this.issueTokens(user.id, user.email, user.role, user.name);
  }

  private async sendVerification(userId: string, email: string): Promise<void> {
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
    });
    const link = `${this.frontendUrl()}/verify-email?token=${raw}`;
    await this.mail.send({
      to: email,
      subject: 'Verifikasi email SGuard',
      text: `Klik tautan berikut untuk memverifikasi email Anda (berlaku 24 jam):\n${link}`,
    });
  }

  frontendUrl(): string {
    return this.config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000';
  }

  private async issueTokens(userId: string, email: string, role: JwtPayload['role'], name: string) {
    const payload: JwtPayload = { sub: userId, email, role };
    const refreshToken = newRefreshToken();
    // Satu sesi per user (satu kolom refresh_token_hash sesuai PRD); login baru menggantikan sesi lama.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshTokenHash: hashToken(refreshToken),
        refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return {
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN') ?? '15m',
      refreshToken,
      user: { id: userId, name, email, role },
    };
  }
}
