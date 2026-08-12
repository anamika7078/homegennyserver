import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeesRepository } from './employees.repository';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserProvisioningModule } from '../auth/user-provisioning.module';

@Module({
  imports: [PrismaModule, UserProvisioningModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeesRepository],
  exports: [EmployeesService, EmployeesRepository],
})
export class EmployeesModule {}
