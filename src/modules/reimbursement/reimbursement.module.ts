import { Module } from '@nestjs/common';
import { ReimbursementController } from './reimbursement.controller';
import { ReimbursementService } from './reimbursement.service';
import { ReimbursementRepository } from './reimbursement.repository';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ReimbursementController],
  providers: [ReimbursementService, ReimbursementRepository],
  exports: [ReimbursementService, ReimbursementRepository],
})
export class ReimbursementModule {}
