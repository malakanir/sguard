import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const NOTIFICATION_EVENTS = ['rule.high', 'sync.failed', 'drift.detected'] as const;

export class CreateChannelDto {
  @IsIn(['EMAIL', 'SLACK', 'WEBHOOK'], { message: 'type harus EMAIL, SLACK, atau WEBHOOK' })
  type!: 'EMAIL' | 'SLACK' | 'WEBHOOK';

  /** Alamat email, atau URL webhook/Slack. */
  @IsString({ message: 'target harus berupa teks' })
  @IsNotEmpty({ message: 'target wajib diisi' })
  @MaxLength(2048)
  target!: string;

  @IsArray({ message: 'events harus berupa daftar' })
  @ArrayNotEmpty({ message: 'pilih minimal satu event' })
  @IsIn(NOTIFICATION_EVENTS, { each: true, message: 'event tidak dikenal' })
  events!: (typeof NOTIFICATION_EVENTS)[number][];

  /** Secret untuk tanda tangan HMAC webhook (opsional). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  secret?: string;
}
