import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { SyncModule } from '../sync/sync.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({
  imports: [GroupsModule, SyncModule],
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
