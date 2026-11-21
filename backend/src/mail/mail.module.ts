import { Global, Module } from '@nestjs/common';
import { MAIL_SENDER, SmtpOrLogMailSender } from './mail.service';

@Global()
@Module({
  providers: [{ provide: MAIL_SENDER, useClass: SmtpOrLogMailSender }],
  exports: [MAIL_SENDER],
})
export class MailModule {}
