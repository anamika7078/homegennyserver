import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { Agreement } from './agreement.entity';
import { StaffApplicant } from '../staff/staff.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Agreement, StaffApplicant])],
  controllers: [AgreementsController],
  providers: [AgreementsService],
})
export class AgreementsModule {}
