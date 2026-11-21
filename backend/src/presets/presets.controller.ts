import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PresetsService } from './presets.service';

const IPV4_CIDR = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(3[0-2]|[12]?\d)$/;

class ApplyPresetDto {
  @IsIn(['web-server', 'ssh-admin', 'db-internal'], { message: 'presetId tidak dikenal' })
  presetId!: 'web-server' | 'ssh-admin' | 'db-internal';

  @IsOptional()
  @Matches(IPV4_CIDR, { message: 'sourceCidr harus CIDR IPv4 yang valid' })
  sourceCidr?: string;
}

@Controller()
export class PresetsController {
  constructor(private readonly presets: PresetsService) {}

  @Get('presets')
  list() {
    return this.presets.list();
  }

  @Post('groups/:id/presets')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyPresetDto,
  ) {
    return this.presets.apply(user.id, id, dto.presetId, dto.sourceCidr);
  }
}
