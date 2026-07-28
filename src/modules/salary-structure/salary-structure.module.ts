import { Module } from '@nestjs/common';
import { SalaryStructureController } from './salary-structure.controller';
import { SalaryStructureService } from './salary-structure.service';
import { SalaryStructureRepository } from './salary-structure.repository';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SalaryStructureController],
  providers: [SalaryStructureService, SalaryStructureRepository],
  exports: [SalaryStructureService, SalaryStructureRepository],
})
export class SalaryStructureModule {}
