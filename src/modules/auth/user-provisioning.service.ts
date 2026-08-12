import { Injectable, Logger, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Temporary default password assigned whenever a creator (Finance/HR/Admin)
 * doesn't supply one explicitly. Accounts created this way are flagged
 * `mustChangePassword` so the app can force a change after first login.
 */
export const DEFAULT_PASSWORD = 'HomeGenny@2024';

/** Matches the bcrypt cost used everywhere else in this codebase for user passwords. */
const PASSWORD_BCRYPT_ROUNDS = 12;

interface CreateUserRowParams {
  phone: string;
  fullName: string;
  email?: string | null;
  role: 'CLIENT' | 'STAFF' | 'RM';
  branchId?: string | null;
  password?: string | null;
}

/**
 * Central place for "creating a person also creates a login". Every business
 * flow that onboards a Client, Staff member, or RM (Finance, HR, Admin) links
 * into here (after creating its own business record) so the resulting
 * account always follows the same default-password / mustChangePassword
 * rule. Deliberately has no dependency on FinanceCustomerService/
 * EmployeesService — those live in modules AuthModule already imports, and
 * this service is imported back by them, so it stays a leaf (Prisma-only)
 * to avoid a module import cycle.
 */
@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks phone (and email, if given) aren't already taken by another login.
   * Callers should run this BEFORE creating the business record (finance
   * customer / employee / staff applicant) so a conflict never leaves an
   * orphaned business row with no linked login — surfaces a clean 409 instead.
   */
  async assertPhoneAvailable(phone: string, email?: string | null): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ phone }, ...(email ? [{ email }] : [])] },
      select: { id: true, phone: true, email: true },
    });
    if (existing) {
      const field = existing.phone === phone ? 'phone' : 'email';
      throw new ConflictException(`An account with this ${field} already exists`);
    }
  }

  /** Creates the `users` row only. Callers link it to a business record afterward. */
  async createUserRow(params: CreateUserRowParams) {
    const usedDefaultPassword = !params.password;
    const passwordHash = await bcrypt.hash(
      params.password || DEFAULT_PASSWORD,
      PASSWORD_BCRYPT_ROUNDS,
    );
    return this.prisma.user.create({
      data: {
        role: params.role,
        fullName: params.fullName,
        phone: params.phone,
        email: params.email ?? null,
        branchId: params.branchId ?? null,
        passwordHash,
        isActive: true,
        metadata: { mustChangePassword: usedDefaultPassword },
      },
    });
  }

  /**
   * Links a login-capable CLIENT user to an already-created finance_customers
   * row. If no phone is supplied there's nothing unique to log in with, so
   * this is a no-op (caller keeps the customer, just without a login).
   */
  async linkClientAccount(params: {
    financeCustomerId: string;
    fullName: string;
    phone?: string;
    email?: string;
    password?: string;
  }) {
    if (!params.phone) {
      this.logger.warn(
        `[PROVISION] finance_customers ${params.financeCustomerId} has no phone — no login account provisioned.`,
      );
      return null;
    }
    const user = await this.createUserRow({
      phone: params.phone,
      fullName: params.fullName,
      email: params.email,
      role: 'CLIENT',
      password: params.password,
    });
    try {
      await this.prisma.financeCustomer.update({
        where: { id: params.financeCustomerId },
        data: { userId: user.id },
      });
    } catch (err) {
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw err;
    }
    return user;
  }

  /**
   * Links a login-capable STAFF user to an already-created `employees` row
   * (and, if present, its synced `staff_applicants` pipeline row matched by
   * mobile).
   */
  async linkStaffAccount(params: {
    employeeId: string;
    mobile: string;
    fullName: string;
    email?: string;
    branchId?: string | null;
    password?: string;
  }) {
    const user = await this.createUserRow({
      phone: params.mobile,
      fullName: params.fullName,
      email: params.email,
      role: 'STAFF',
      branchId: params.branchId,
      password: params.password,
    });
    try {
      await this.prisma.employee.update({
        where: { id: params.employeeId },
        data: { userId: user.id },
      });
      const staffApplicant = await this.prisma.staffApplicant.findFirst({
        where: { mobile: params.mobile },
      });
      if (staffApplicant) {
        await this.prisma.staffApplicant.update({
          where: { id: staffApplicant.id },
          data: { userId: user.id },
        });
      }
    } catch (err) {
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw err;
    }
    return user;
  }

  /**
   * Links a login-capable STAFF user to an already-created lightweight
   * `staff_applicants` row (Admin's quick-add path — no payroll-grade
   * `employees` record, since that form doesn't collect the full HR data).
   */
  async linkLightweightStaffAccount(params: {
    staffApplicantId: string;
    phone: string;
    fullName: string;
    email?: string;
    branchId?: string | null;
    password?: string;
  }) {
    const user = await this.createUserRow({
      phone: params.phone,
      fullName: params.fullName,
      email: params.email,
      role: 'STAFF',
      branchId: params.branchId,
      password: params.password,
    });
    try {
      await this.prisma.staffApplicant.update({
        where: { id: params.staffApplicantId },
        data: { userId: user.id },
      });
    } catch (err) {
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw err;
    }
    return user;
  }

  /** RM has no dedicated profile table — just a bare login-capable users row. */
  async provisionRmAccount(params: {
    fullName: string;
    phone: string;
    email?: string;
    branchId?: string | null;
    password?: string;
  }) {
    return this.createUserRow({
      phone: params.phone,
      fullName: params.fullName,
      email: params.email,
      role: 'RM',
      branchId: params.branchId,
      password: params.password,
    });
  }
}
