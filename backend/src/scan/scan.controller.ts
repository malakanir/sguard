import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ScanService } from './scan.service';

@Controller('groups')
export class ScanController {
  constructor(private readonly scan: ScanService) {}

  @Post(':id/scan')
  @HttpCode(HttpStatus.OK)
  scanNow(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scan.scanGroupAs(user.id, id);
  }
}
