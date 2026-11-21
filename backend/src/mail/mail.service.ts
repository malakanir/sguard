import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Kontrak pengiriman email. Test bisa menggantinya untuk menangkap isi email. */
export interface MailSender {
  send(mail: OutgoingMail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

/**
 * MAIL_TRANSPORT=smtp: kirim lewat SMTP (Mailpit di docker compose, port 1025).
 * Selain itu (default): tulis ke log, sehingga link verifikasi bisa dilihat saat development.
 */
@Injectable()
export class SmtpOrLogMailSender implements MailSender {
  private readonly logger = new Logger('Mail');
  private readonly transporter?: nodemailer.Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.from = config.get<string>('MAIL_FROM') ?? 'SGuard <noreply@sguard.local>';
    if (config.get<string>('MAIL_TRANSPORT') === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: config.get<string>('SMTP_HOST') ?? '127.0.0.1',
        port: Number(config.get<string>('SMTP_PORT') ?? 1025),
        secure: false,
      });
    }
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[email] untuk ${mail.to}: ${mail.subject}\n${mail.text}`);
      return;
    }
    await this.transporter.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}
