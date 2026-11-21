import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { SyncCoreModule } from './sync-core.module';
import { SyncFacade } from './sync-facade';
import { SYNC_BACKEND, SYNC_PORT } from './sync-port';
import { RemoteSyncPort } from './remote-sync.port';
import { SyncService } from './sync.service';

/**
 * Sisi API. SYNC_TRANSPORT=local: sinkronisasi di proses API.
 * SYNC_TRANSPORT=tcp: diteruskan ke sync-worker (SYNC_WORKER_HOST:SYNC_WORKER_PORT).
 */
@Module({
  imports: [SyncCoreModule],
  providers: [
    {
      provide: SYNC_BACKEND,
      inject: [ConfigService, SyncService],
      useFactory: (config: ConfigService, local: SyncService) => {
        if (config.get<string>('SYNC_TRANSPORT') !== 'tcp') return local;
        const client = ClientProxyFactory.create({
          transport: Transport.TCP,
          options: {
            host: config.get<string>('SYNC_WORKER_HOST') ?? '127.0.0.1',
            port: Number(config.get<string>('SYNC_WORKER_PORT') ?? 4010),
          },
        });
        return new RemoteSyncPort(client);
      },
    },
    { provide: SYNC_PORT, useClass: SyncFacade },
  ],
  exports: [SYNC_PORT],
})
export class SyncModule {}
