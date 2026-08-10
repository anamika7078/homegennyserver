import { Module } from '@nestjs/common';
import { RightToRefuseController } from './right-to-refuse.controller';
import { RightToRefuseService } from './right-to-refuse.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [RightToRefuseController],
  providers: [RightToRefuseService],
  exports: [RightToRefuseService],
})
export class RightToRefuseModule {}
