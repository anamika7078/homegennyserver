import { Module } from '@nestjs/common';
import { EmployeeSalaryController } from './employee-salary.controller';
import { EmployeeSalaryService } from './employee-salary.service';
import { EmployeeSalaryRepository } from './employee-salary.repository';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EmployeeSalaryController],
  providers: [EmployeeSalaryService, EmployeeSalaryRepository],
  exports: [EmployeeSalaryService, EmployeeSalaryRepository],
})
export class EmployeeSalaryModule {}
