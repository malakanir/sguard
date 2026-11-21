import { Module } from '@nestjs/common';
import { RulesModule } from '../rules/rules.module';
import { PresetsController } from './presets.controller';
import { PresetsService } from './presets.service';

@Module({
  imports: [RulesModule],
  controllers: [PresetsController],
  providers: [PresetsService],
})
export class PresetsModule {}
