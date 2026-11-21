import { Module } from '@nestjs/common';
import { SyncCoreModule } from '../sync/sync-core.module';
import { AwsAccountsController } from './aws-accounts.controller';
import { AwsAccountsService } from './aws-accounts.service';

@Module({
  imports: [SyncCoreModule],
  controllers: [AwsAccountsController],
  providers: [AwsAccountsService],
})
export class AwsAccountsModule {}
