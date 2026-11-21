import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoModule } from '../common/crypto.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncCoreModule } from '../sync/sync-core.module';
import { SyncWorkerController } from './sync-worker.controller';

/** sync-worker: service NestJS terpisah yang hanya menjalankan sinkronisasi (FR-23). */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), PrismaModule, CryptoModule, SyncCoreModule],
  controllers: [SyncWorkerController],
})
export class WorkerModule {}
