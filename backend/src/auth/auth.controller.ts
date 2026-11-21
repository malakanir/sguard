import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService, GithubProfile } from './auth.service';
import { GithubAuthGuard } from './github-auth.guard';
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto';

class VerifyEmailQuery {
  @IsString({ message: 'token wajib diisi' })
  @IsNotEmpty({ message: 'token wajib diisi' })
  token!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('config')
  config() {
    return this.auth.publicConfig();
  }

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.logout(user.id);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Public()
  @Get('verify-email')
  verifyEmail(@Query() query: VerifyEmailQuery) {
    return this.auth.verifyEmail(query.token);
  }

  @Public()
  @Get('github')
  @UseGuards(GithubAuthGuard)
  github() {
    // Guard mengarahkan browser ke GitHub; handler ini tidak pernah dijalankan.
  }

  @Public()
  @Get('github/callback')
  @UseGuards(GithubAuthGuard)
  async githubCallback(@Req() req: Request & { user: GithubProfile }, @Res() res: Response) {
    const tokens = await this.auth.loginWithGithub(req.user);
    // Token dikirim di fragment (#) agar tidak masuk ke log server atau header Referer.
    const fragment = new URLSearchParams({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    res.redirect(`${this.auth.frontendUrl()}/auth/callback#${fragment.toString()}`);
  }
}
