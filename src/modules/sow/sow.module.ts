import { Module } from '@nestjs/common';
import { SowController } from './sow.controller';
import { SowService } from './sow.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [SowController],
  providers: [SowService],
  exports: [SowService],
})
export class SowModule {}
