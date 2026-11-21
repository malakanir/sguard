import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AwsAccountsService } from './aws-accounts.service';
import { CreateAwsAccountDto } from './dto/aws-account.dto';

@Controller('aws-accounts')
export class AwsAccountsController {
  constructor(private readonly accounts: AwsAccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.accounts.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAwsAccountDto) {
    return this.accounts.create(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.remove(user.id, id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.test(user.id, id);
  }
}
