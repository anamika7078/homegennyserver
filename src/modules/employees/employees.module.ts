import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeesRepository } from './employees.repository';
import { EmployeeOnboardingService } from './employee-onboarding.service';
import { EmployeeProfileService } from './employee-profile.service';
import { EmployeePayslipService } from './employee-payslip.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserProvisioningModule } from '../auth/user-provisioning.module';

@Module({
  imports: [PrismaModule, UserProvisioningModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    EmployeesRepository,
    EmployeeOnboardingService,
    EmployeeProfileService,
    EmployeePayslipService,
  ],
  exports: [
    EmployeesService,
    EmployeesRepository,
    EmployeeOnboardingService,
    EmployeeProfileService,
    EmployeePayslipService,
  ],
})
export class EmployeesModule {}
