import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { isEmail } from 'class-validator';
import { CryptoService } from '../common/crypto.service';
import {
  DriftDetectedEvent,
  EVENT_DRIFT_DETECTED,
  EVENT_RULE_HIGH,
  EVENT_SYNC_CHANGED,
  RuleHighEvent,
  SyncChangedEvent,
} from '../events/app-events';
import { MAIL_SENDER, MailSender } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { Inject } from '@nestjs/common';
import { CreateChannelDto } from './dto/channel.dto';
import { assertSafeWebhookUrl } from './url-guard';

const DELIVERY_TIMEOUT_MS = 5000;

/** Bentuk yang aman ditampilkan ke user: tanpa target atau secret lengkap. */
function targetHint(type: NotificationChannel['type'], target: string): string {
  if (type === 'EMAIL') {
    const [name, domain] = target.split('@');
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return new URL(target).origin;
}

/**
 * Notifikasi keluar (PRD FR-28): email, Slack, dan webhook. Target dan secret disimpan terenkripsi.
 * Webhook memakai skema tanda tangan Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  async list(userId: string) {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return channels.map((c) => this.toView(c));
  }

  async create(userId: string, dto: CreateChannelDto) {
    await this.validateTarget(dto.type, dto.target);
    const channel = await this.prisma.notificationChannel.create({
      data: {
        userId,
        type: dto.type,
        targetEnc: this.crypto.encrypt(dto.target),
        secretEnc: dto.secret ? this.crypto.encrypt(dto.secret) : null,
        events: [...new Set(dto.events)],
      },
    });
    return this.toView(channel);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notificationChannel.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('Channel tidak ditemukan.');
  }

  /** Kirim pesan uji ke satu channel milik user. Hasilnya langsung terlihat. */
  async test(userId: string, id: string) {
    const channel = await this.prisma.notificationChannel.findFirst({ where: { id, userId } });
    if (!channel) throw new NotFoundException('Channel tidak ditemukan.');
    // Kegagalan pengiriman sudah dicatat di channel (lastStatus, lastError); tidak dilempar ke klien.
    await this.deliver(channel, 'test', { message: 'Tes notifikasi dari SGuard.' }, 'Tes notifikasi dari SGuard.').catch(() => undefined);
    const updated = await this.prisma.notificationChannel.findUniqueOrThrow({ where: { id } });
    return this.toView(updated);
  }

  @OnEvent(EVENT_RULE_HIGH)
  onRuleHigh(event: RuleHighEvent): void {
    const data = { groupId: event.groupId, ruleId: event.ruleId, name: event.name, riskReason: event.riskReason };
    void this.dispatch(event.ownerId, 'rule.high', data, `Rule HIGH dibuat: ${event.name}. ${event.riskReason ?? ''}`);
  }

  @OnEvent(EVENT_SYNC_CHANGED)
  onSyncChanged(event: SyncChangedEvent): void {
    if (event.status !== 'FAILED') return;
    const data = { groupId: event.groupId, ruleId: event.ruleId, kind: event.kind, name: event.name, error: event.error };
    void this.dispatch(event.ownerId, 'sync.failed', data, `Sync gagal: ${event.name}. ${event.error ?? ''}`);
  }

  @OnEvent(EVENT_DRIFT_DETECTED)
  onDriftDetected(event: DriftDetectedEvent): void {
    const data = {
      groupId: event.groupId,
      name: event.name,
      missingInCloud: event.missingInCloud,
      extraInCloud: event.extraInCloud,
      groupMissingInCloud: event.groupMissingInCloud,
    };
    void this.dispatch(event.ownerId, 'drift.detected', data, `Drift terdeteksi pada group ${event.name}.`);
  }

  private async dispatch(ownerId: string, eventName: string, data: object, text: string): Promise<void> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { userId: ownerId, enabled: true, events: { has: eventName } },
    });
    await Promise.all(
      channels.map((channel) =>
        this.deliver(channel, eventName, data, text).catch((err) =>
          this.logger.warn(`Notifikasi ${eventName} ke channel ${channel.id} gagal: ${String(err?.message ?? err)}`),
        ),
      ),
    );
  }

  private async deliver(channel: NotificationChannel, eventName: string, data: object, text: string): Promise<void> {
    const target = this.crypto.decrypt(channel.targetEnc);
    try {
      if (channel.type === 'EMAIL') {
        await this.mail.send({ to: target, subject: `[SGuard] ${eventName}`, text });
      } else if (channel.type === 'SLACK') {
        await this.postJson(target, JSON.stringify({ text }), {});
      } else {
        await this.deliverWebhook(channel, target, eventName, data);
      }
      await this.recordResult(channel.id, 'OK', null);
    } catch (err) {
      await this.recordResult(channel.id, 'ERROR', String((err as Error)?.message ?? err).slice(0, 200));
      throw err;
    }
  }

  private async deliverWebhook(channel: NotificationChannel, target: string, eventName: string, data: object) {
    await this.assertSafe(target);
    const body = JSON.stringify({ type: eventName, data, sentAt: new Date().toISOString() });
    const id = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'webhook-id': id, 'webhook-timestamp': timestamp };
    if (channel.secretEnc) {
      // Standard Webhooks: HMAC-SHA256 atas "id.timestamp.body", dikodekan base64, prefiks v1.
      const secret = this.crypto.decrypt(channel.secretEnc);
      const signature = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
      headers['webhook-signature'] = `v1,${signature}`;
    }
    await this.postJson(target, body, headers);
  }

  private async postJson(url: string, body: string, extraHeaders: Record<string, string>): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SGuard-Notifier/1', ...extraHeaders },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  private async recordResult(id: string, status: 'OK' | 'ERROR', error: string | null): Promise<void> {
    await this.prisma.notificationChannel.update({
      where: { id },
      data: {
        lastStatus: status,
        lastError: error,
        ...(status === 'OK' ? { lastDeliveredAt: new Date() } : {}),
      },
    });
  }

  private async validateTarget(type: CreateChannelDto['type'], target: string): Promise<void> {
    if (type === 'EMAIL') {
      if (!isEmail(target)) throw new BadRequestException('Alamat email tidak valid.');
      return;
    }
    await this.assertSafe(target);
    // Host Slack default hooks.slack.com. SLACK_WEBHOOK_HOST hanya untuk pengujian terhadap server tiruan.
    const slackHost = this.config.get<string>('SLACK_WEBHOOK_HOST') ?? 'hooks.slack.com';
    if (type === 'SLACK' && new URL(target).hostname !== slackHost) {
      throw new BadRequestException(`URL Slack harus berawalan https://${slackHost}/.`);
    }
  }

  private assertSafe(target: string): Promise<URL> {
    return assertSafeWebhookUrl(target, {
      allowInsecure: this.config.get<string>('ALLOW_INSECURE_WEBHOOKS') === 'true',
      allowPrivate: this.config.get<string>('ALLOW_PRIVATE_WEBHOOKS') === 'true',
    });
  }

  private toView(channel: NotificationChannel) {
    return {
      id: channel.id,
      type: channel.type,
      targetHint: targetHint(channel.type, this.crypto.decrypt(channel.targetEnc)),
      hasSecret: channel.secretEnc !== null,
      events: channel.events,
      enabled: channel.enabled,
      lastStatus: channel.lastStatus,
      lastError: channel.lastError,
      lastDeliveredAt: channel.lastDeliveredAt,
      createdAt: channel.createdAt,
    };
  }
}
