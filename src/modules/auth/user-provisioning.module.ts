import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UserProvisioningService } from './user-provisioning.service';

/**
 * Standalone (Prisma-only) module so Finance/Employees/Admin/Auth modules can
 * all import it without creating a circular dependency between each other.
 */
@Module({
  imports: [PrismaModule],
  providers: [UserProvisioningService],
  exports: [UserProvisioningService],
})
export class UserProvisioningModule {}
