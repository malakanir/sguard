import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOUD_CLIENT, Ec2CloudClient, StubCloudClient } from './cloud-client';
import { CloudClientResolver } from './cloud-client-resolver';
import { SyncService } from './sync.service';

/** Logika sinkronisasi ke cloud. Dipakai oleh API (mode lokal) dan sync-worker. */
@Module({
  providers: [
    SyncService,
    CloudClientResolver,
    {
      provide: CLOUD_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // SYNC_MODE=floci (default, lokal) atau stub (tanpa panggilan jaringan).
        if (config.get<string>('SYNC_MODE') === 'stub') return new StubCloudClient();
        return new Ec2CloudClient({
          region: config.get<string>('AWS_REGION') ?? 'us-east-1',
          endpoint: config.getOrThrow<string>('FLOCI_ENDPOINT'),
          // Floci tidak memerlukan kredensial asli; nilai dummy cukup.
          accessKeyId: 'floci-dummy',
          secretAccessKey: 'floci-dummy',
        });
      },
    },
  ],
  exports: [SyncService, CLOUD_CLIENT, CloudClientResolver],
})
export class SyncCoreModule {}
