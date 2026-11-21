import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GroupsModule } from './groups/groups.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { PresetsModule } from './presets/presets.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportsModule } from './reports/reports.module';
import { RulesModule } from './rules/rules.module';
import { ScanModule } from './scan/scan.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AwsAccountsModule } from './aws-accounts/aws-accounts.module';
import { AccessModule } from './access/group-access.service';
import { CryptoModule } from './common/crypto.service';
import { RateLimitModule } from './common/rate-limit.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AccessModule,
    CryptoModule,
    RateLimitModule,
    HealthModule,
    PrismaModule,
    MailModule,
    AuthModule,
    AuditModule,
    GroupsModule,
    RulesModule,
    PresetsModule,
    ReportsModule,
    DashboardModule,
    AdminModule,
    RealtimeModule,
    ScanModule,
    NotificationsModule,
    AwsAccountsModule,
  ],
})
export class AppModule {}
