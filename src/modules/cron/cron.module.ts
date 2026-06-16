import { Module } from '@nestjs/common';
import { EnterpriseCronService } from './enterprise-cron.service';

@Module({
  providers: [EnterpriseCronService],
})
export class EnterpriseCronModule {}
