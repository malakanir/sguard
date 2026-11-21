import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateRuleDto, RuleListQueryDto, UpdateRuleDto } from './dto/rule.dto';
import { RulesService } from './rules.service';

@Controller()
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('rules')
  list(@CurrentUser() user: AuthUser, @Query() query: RuleListQueryDto) {
    return this.rules.list(user.id, query);
  }

  @Post('groups/:groupId/rules')
  create(
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateRuleDto,
  ) {
    return this.rules.create(user.id, groupId, dto);
  }

  @Get('rules/:id')
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rules.findOne(user.id, id);
  }

  @Patch('rules/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRuleDto,
  ) {
    return this.rules.update(user.id, id, dto);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rules.remove(user.id, id);
  }
}
