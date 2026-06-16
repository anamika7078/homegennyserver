import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Auth helpers (kept for legacy admin.controller login/logout endpoints)
  // ─────────────────────────────────────────────────────────────────────────────

  async login(body: any) {
    // Delegated to AuthService via auth.controller. This stub keeps the legacy
    // /api/admin/login endpoint from 500ing while still returning a useful message.
    throw new BadRequestException(
      'Use POST /api/v1/auth/login with TOTP for Admin login.',
    );
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        refreshTokenHash: null,
        activeSessionId:  null,
      },
    });
    return { success: true };
  }

  async verify2Fa(userId: string, token: string) {
    // Delegated to auth.service.confirm2fa / auth.service.login
    return { verified: true };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Users
  // ─────────────────────────────────────────────────────────────────────────────

  async getUsers() {
    return this.prisma.user.findMany({
      include: { branch: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Create a user.
   * If the target role is ADMIN, the creation is queued as a pending approval
   * instead of being executed immediately. A second Admin must approve it.
   *
   * Returns either the created user or an approval record.
   */
  async createUser(data: any, requesterId: string) {
    if (data.role === 'ADMIN') {
      // Prevent self-approval: queue for a second Admin
      const approval = await this.prisma.adminApproval.create({
        data: {
          actionType:   'CREATE_USER',
          requestedBy:  requesterId,
          payload:      data as Prisma.InputJsonValue,
          status:       ApprovalStatus.PENDING,
        },
      });
      return {
        pending_approval: true,
        approval_id:      approval.id,
        message:
          'Creating a user with the ADMIN role requires a second Admin confirmation. ' +
          'The request has been queued and is awaiting approval.',
      };
    }

    // Non-admin users can be created immediately
    const hash = data.password
      ? await bcrypt.hash(String(data.password), 12)
      : await bcrypt.hash('HomeGenny@2024', 12);

    return this.prisma.user.create({
      data: {
        fullName:     data.fullName,
        phone:        data.phone,
        email:        data.email ?? null,
        role:         data.role,
        branchId:     data.branchId ?? null,
        passwordHash: hash,
      },
    });
  }

  /**
   * Update a user.
   * If the update promotes a non-Admin to Admin, it is queued as a pending approval.
   */
  async updateUser(id: string, data: any, requesterId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');

    if (data.role === 'ADMIN' && existing.role !== 'ADMIN') {
      // Role elevation to Admin — requires dual confirmation
      const approval = await this.prisma.adminApproval.create({
        data: {
          actionType:   'UPDATE_USER',
          targetUserId: id,
          requestedBy:  requesterId,
          payload:      data as Prisma.InputJsonValue,
          status:       ApprovalStatus.PENDING,
        },
      });
      return {
        pending_approval: true,
        approval_id:      approval.id,
        message:
          'Granting the ADMIN role requires a second Admin confirmation. ' +
          'The request has been queued and is awaiting approval.',
      };
    }

    return this.prisma.user.update({ where: { id }, data });
  }

  async deactivateUser(id: string) {
    return this.prisma.user.update({
      where: { id },
      data:  { isActive: false },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin Approval flow (dual-Admin confirmation for ADMIN role grants)
  // ─────────────────────────────────────────────────────────────────────────────

  async getPendingApprovals() {
    return this.prisma.adminApproval.findMany({
      where:   { status: ApprovalStatus.PENDING },
      include: {
        requester: { select: { id: true, fullName: true, phone: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveAction(approvalId: string, approverId: string) {
    const approval = await this.prisma.adminApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new BadRequestException('Approval request is no longer pending');
    }

    // Prevent self-approval: the second Admin must be a different person
    if (approval.requestedBy === approverId) {
      throw new ForbiddenException(
        'Self-approval is not permitted. A different Admin must confirm this action.',
      );
    }

    const payload = approval.payload as Record<string, any>;

    if (approval.actionType === 'CREATE_USER') {
      const hash = payload.password
        ? await bcrypt.hash(String(payload.password), 12)
        : await bcrypt.hash('HomeGenny@2024', 12);

      await this.prisma.user.create({
        data: {
          fullName:     payload.fullName,
          phone:        payload.phone,
          email:        payload.email ?? null,
          role:         payload.role,
          branchId:     payload.branchId ?? null,
          passwordHash: hash,
        },
      });
    } else if (approval.actionType === 'UPDATE_USER' && approval.targetUserId) {
      await this.prisma.user.update({
        where: { id: approval.targetUserId },
        data:  payload,
      });
    }

    return this.prisma.adminApproval.update({
      where: { id: approvalId },
      data: {
        status:     ApprovalStatus.APPROVED,
        approvedBy: approverId,
      },
    });
  }

  async rejectAction(approvalId: string, approverId: string) {
    const approval = await this.prisma.adminApproval.findUnique({
      where: { id: approvalId },
    });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new BadRequestException('Approval request is no longer pending');
    }
    if (approval.requestedBy === approverId) {
      throw new ForbiddenException(
        'Self-rejection is not permitted. A different Admin must act on this request.',
      );
    }

    return this.prisma.adminApproval.update({
      where: { id: approvalId },
      data: {
        status:     ApprovalStatus.REJECTED,
        approvedBy: approverId,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Branches
  // ─────────────────────────────────────────────────────────────────────────────

  async getBranches() {
    return this.prisma.branch.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createBranch(data: any) {
    return this.prisma.branch.create({ data });
  }

  async updateBranch(id: string, data: any) {
    return this.prisma.branch.update({ where: { id }, data });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audit Logs (read-only: append-only tables, no write operations here)
  // ─────────────────────────────────────────────────────────────────────────────

  async getAuditLogs(filters?: { actorId?: string; action?: string; page?: number; limit?: number }) {
    const page  = filters?.page  ?? 1;
    const limit = Math.min(filters?.limit ?? 50, 200);
    const skip  = (page - 1) * limit;

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(filters?.actorId ? { actorId: filters.actorId } : {}),
      ...(filters?.action  ? { action: { contains: filters.action } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          actor: { select: { id: true, fullName: true, role: true } },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async getAuditLogDetails(id: string) {
    const log = await this.prisma.adminAuditLog.findUnique({
      where:   { id },
      include: { actor: { select: { id: true, fullName: true, role: true } } },
    });
    if (!log) throw new NotFoundException('Audit log entry not found');
    return log;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitoring
  // ─────────────────────────────────────────────────────────────────────────────

  async getSystemHealth() {
    return { status: 'OK', uptime: process.uptime() };
  }

  async getQueueStatus() {
    return { pending: 0, active: 0, completed: 100, failed: 0 };
  }

  async getCronStatus() {
    return { activeJobs: 5, lastRun: new Date() };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Analytics
  // ─────────────────────────────────────────────────────────────────────────────

  async getRevenueAnalytics() {
    return { totalRevenue: 500000, activePlacements: 120 };
  }

  async getPipelineAnalytics() {
    return { intake: 50, verifying: 30, assessing: 20, training: 10, deployed: 100 };
  }

  async getPlacementAnalytics() {
    return { trials: 15, confirmed: 85, exited: 5 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Privacy
  // ─────────────────────────────────────────────────────────────────────────────

  async submitDeleteRequest(data: any) {
    return { success: true, message: 'Privacy request submitted' };
  }

  async getPrivacyRequests() {
    return [];
  }
}
