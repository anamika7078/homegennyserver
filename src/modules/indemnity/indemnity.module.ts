import { Module } from '@nestjs/common';
import { IndemnityController } from './indemnity.controller';
import { IndemnityService } from './indemnity.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [IndemnityController],
  providers: [IndemnityService],
  exports: [IndemnityService],
})
export class IndemnityModule {}
