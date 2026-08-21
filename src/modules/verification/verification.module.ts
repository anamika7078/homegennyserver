import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [HttpModule, AuditModule],
  providers: [VerificationService],
  controllers: [VerificationController],
  exports: [VerificationService],
})
export class VerificationModule {}