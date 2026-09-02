import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeesService } from './employees.service';
import { UserProvisioningService } from '../auth/user-provisioning.service';

export interface OnboardFromPipelineDto {
  staffApplicantId: string;
  // HR-only fields — the S1-S5 pipeline never collects these.
  department: string;
  designation: string;
  categoryId: string;
  employmentType: string;
  salary: number | string;
  joiningDate: string;
  gender: string;
  // Optional overrides for fields the pipeline may have left blank.
  city?: string;
  state?: string;
  pincode?: string;
  reportingManager?: string;
  bloodGroup?: string;
  maritalStatus?: string;
  alternateMobile?: string;
  password?: string;
}

/**
 * The bridge between the RM pipeline and HR.
 *
 * A candidate lives in `staff_applicants` while moving S1_INTAKE -> S5_DEPLOY.
 * Once deployed they are a working employee, and HR needs them in `employees`
 * so attendance, salary and payslips have somewhere to hang. Nothing used to
 * perform that conversion — `employees` rows were only ever created by hand,
 * and were tied back to a pipeline row by a mobile-number lookup. This service
 * is the one supported path, and it links the two by real foreign key.
 *
 * The applicant row is never mutated or deleted: it stays the permanent record
 * of how this person got hired.
 */
@Injectable()
export class EmployeeOnboardingService {
  private readonly logger = new Logger(EmployeeOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly userProvisioning: UserProvisioningService,
  ) {}

  /**
   * Deployed candidates who do not yet have an `employees` record — HR's
   * "pending onboarding" worklist.
   */
  async listPendingOnboarding(params: { branchId?: string; search?: string; limit?: number } = {}) {
    const limit = Math.min(Number(params.limit ?? 100), 500);
    const items = await this.prisma.staffApplicant.findMany({
      where: {
        pipelineStage: 'S5_DEPLOY',
        deletedAt: null,
        terminalOutcome: null,
        employeeRecord: { is: null },
        ...(params.branchId ? { branchId: params.branchId } : {}),
        ...(params.search
          ? {
              OR: [
                { fullName: { contains: params.search, mode: 'insensitive' as const } },
                { staffCode: { contains: params.search, mode: 'insensitive' as const } },
                { mobile: { contains: params.search } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        staffCode: true,
        fullName: true,
        series: true,
        mobile: true,
        email: true,
        branchId: true,
        pipelineStage: true,
        restrictedListFlag: true,
        createdAt: true,
        branch: { select: { id: true, name: true } },
        assignedRm: { select: { id: true, fullName: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return { items, total: items.length };
  }

  /**
   * Converts one S5_DEPLOY candidate into an `employees` record.
   *
   * Hard gates live here; the agreement / placement rules are deliberately NOT
   * re-checked, because `PipelineFsmService.checkDeploymentEligibility` already
   * owns them at the S4 -> S5 transition. Duplicating a business rule in two
   * places is how the two copies drift apart. They are reported as `warnings`
   * instead, which covers rows that reached S5 through a seed or an admin
   * backfill rather than through the FSM.
   */
  /**
   * The one rule about who may become an employee, kept in one place because
   * two endpoints enforce it: this service, and the direct `POST /employees`
   * that HR uses for corrections.
   *
   * Every employee is a person the pipeline placed with a client — there is no
   * separate population of internal hires. See ONE_STAFF_MODEL_PLAN.md §B4.
   */
  async assertOnboardable(staffApplicantId: string) {
    const applicant = await this.prisma.staffApplicant.findFirst({
      where: { id: staffApplicantId, deletedAt: null },
      include: {
        employeeRecord: { select: { id: true, employeeId: true } },
        agreements: { select: { status: true } },
      },
    });

    if (!applicant) {
      throw new NotFoundException(`Staff applicant ${staffApplicantId} not found`);
    }
    if (applicant.employeeRecord) {
      throw new ConflictException(
        `${applicant.fullName} is already onboarded as employee ${applicant.employeeRecord.employeeId}`,
      );
    }
    if (applicant.pipelineStage !== 'S5_DEPLOY') {
      throw new BadRequestException(
        `Only candidates at S5_DEPLOY can be onboarded — ${applicant.staffCode} is at ${applicant.pipelineStage}`,
      );
    }
    return applicant;
  }

  async onboardFromPipeline(dto: OnboardFromPipelineDto, actorId: string) {
    const applicant = await this.assertOnboardable(dto.staffApplicantId);
    if (applicant.terminalOutcome) {
      throw new BadRequestException(
        `${applicant.staffCode} has exited the pipeline (${applicant.terminalOutcome}) and cannot be onboarded`,
      );
    }
    if (applicant.restrictedListFlag) {
      throw new ForbiddenException(
        `${applicant.staffCode} is on the restricted list — clear the entry before onboarding`,
      );
    }

    const required: (keyof OnboardFromPipelineDto)[] = [
      'department',
      'designation',
      'categoryId',
      'employmentType',
      'joiningDate',
      'gender',
    ];
    const missing = required.filter((k) => !dto[k]);
    const salaryMissing =
      dto.salary === undefined || dto.salary === null || String(dto.salary).trim() === '';
    if (missing.length || salaryMissing) {
      throw new BadRequestException(
        `Missing required HR fields: ${[...missing, ...(salaryMissing ? ['salary'] : [])].join(', ')}`,
      );
    }
    const salary = Number(dto.salary);
    if (!Number.isFinite(salary) || salary < 0) {
      throw new BadRequestException('salary must be a non-negative number');
    }

    const warnings: string[] = [];
    if (!applicant.agreements.some((a) => a.status === 'SIGNED')) {
      warnings.push('No SIGNED agreement on record for this candidate');
    }
    if (!applicant.branchId) {
      warnings.push('Candidate had no branch — employee assigned to the default branch');
    }

    // The pipeline stores one free-text address; `employees` splits out
    // city/state/pincode, which S1 intake never captured. Fall back rather
    // than reject, and let HR correct it on the employee record afterwards.
    const employee = await this.employees.create({
      staffApplicantId: applicant.id,
      fullName: applicant.fullName,
      mobile: applicant.mobile,
      alternateMobile: dto.alternateMobile ?? applicant.emergencyContactMobile ?? null,
      email: applicant.email,
      dateOfBirth: applicant.dateOfBirth,
      gender: dto.gender,
      bloodGroup: dto.bloodGroup,
      maritalStatus: dto.maritalStatus,
      address: applicant.address,
      city: dto.city || 'NOT_SET',
      state: dto.state || 'NOT_SET',
      pincode: dto.pincode || 'NOT_SET',
      emergencyContact: {
        name: applicant.emergencyContactName ?? null,
        mobile: applicant.emergencyContactMobile ?? null,
      },
      joiningDate: dto.joiningDate,
      branchId: applicant.branchId,
      department: dto.department,
      designation: dto.designation,
      categoryId: dto.categoryId,
      reportingManager: dto.reportingManager,
      employmentType: dto.employmentType,
      salary,
      status: 'Active',
    });

    // Reuse the candidate's existing login instead of minting a second one.
    // `users.phone` is UNIQUE, so provisioning a fresh STAFF account for
    // someone who already signed in through the mobile app would just 409.
    let linkedUserId = applicant.userId ?? null;
    try {
      if (linkedUserId) {
        await this.prisma.employee.update({
          where: { id: employee.id },
          data: { userId: linkedUserId },
        });
      } else {
        const user = await this.userProvisioning.linkStaffAccount({
          employeeId: employee.id,
          staffApplicantId: applicant.id,
          mobile: applicant.mobile,
          fullName: applicant.fullName,
          email: applicant.email ?? undefined,
          branchId: applicant.branchId,
          password: dto.password,
        });
        linkedUserId = user.id;
      }
    } catch (err) {
      warnings.push(
        `Employee created but login account could not be linked: ${(err as Error).message}`,
      );
      this.logger.warn(
        `[ONBOARD] employee ${employee.id} created without a linked login — ${(err as Error).message}`,
      );
    }

    await this.prisma.pipelineEvent.create({
      data: {
        staffId: applicant.id,
        eventType: 'EMPLOYEE_ONBOARDED',
        fromStage: applicant.pipelineStage,
        toStage: applicant.pipelineStage,
        actorId,
        notes: `Onboarded to HR as employee ${employee.employeeId}`,
        payload: {
          employeeId: employee.id,
          employeeCode: employee.employeeId,
          department: dto.department,
          designation: dto.designation,
          warnings,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'APPROVAL',
        entityType: 'employee',
        entityId: employee.id,
        after: {
          onboardedFrom: applicant.id,
          staffCode: applicant.staffCode,
          employeeCode: employee.employeeId,
        },
        metadata: { flow: 'onboard-from-pipeline', warnings },
      },
    });

    this.logger.log(
      `[ONBOARD] ${applicant.staffCode} -> employee ${employee.employeeId} by ${actorId}`,
    );

    return {
      employee: await this.employees.findOne(employee.id),
      staffApplicantId: applicant.id,
      staffCode: applicant.staffCode,
      linkedUserId,
      warnings,
    };
  }
}
