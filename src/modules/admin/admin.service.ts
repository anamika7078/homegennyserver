import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { VideoCertService } from '../video-cert/video-cert.service';
import { ApprovalStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const PIPELINE_STAGES = [
  'S1_INTAKE',
  'S2_VERIFY',
  'S2_5_ASSESS',
  'S3_TRAIN',
  'S4_AGREEMENTS',
  'S5_DEPLOY',
  'DEFERRED',
  'TERMINAL',
] as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monitoringService: MonitoringService,
    private readonly videoCertService: VideoCertService,
  ) {}

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
    return this.monitoringService.getQueueCounts();
  }

  async getFailedQueueJobs(limit = 20) {
    return this.monitoringService.getFailedJobs(limit);
  }

  async retryFailedQueueJobs() {
    return this.monitoringService.retryFailedJobs();
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
    const stages = await this.prisma.staffApplicant.groupBy({
      by: ['pipelineStage'],
      where: { deletedAt: null },
      _count: true,
    });
    const map = Object.fromEntries(stages.map((s) => [s.pipelineStage, s._count]));
    return {
      intake: map.S1_INTAKE ?? 0,
      verifying: map.S2_VERIFY ?? 0,
      assessing: map.S2_5_ASSESS ?? 0,
      training: map.S3_TRAIN ?? 0,
      agreements: map.S4_AGREEMENTS ?? 0,
      deployed: map.S5_DEPLOY ?? 0,
      deferred: map.DEFERRED ?? 0,
      terminal: map.TERMINAL ?? 0,
    };
  }

  async getPipelineOverview() {
    const baseWhere: Prisma.StaffApplicantWhereInput = { deletedAt: null };

    const [stageCounts, seriesDist, recentEvents, kpis] = await Promise.all([
      this.prisma.staffApplicant.groupBy({
        by: ['pipelineStage'],
        where: baseWhere,
        _count: true,
      }),
      this.prisma.staffApplicant.groupBy({
        by: ['series'],
        where: { ...baseWhere, pipelineStage: { not: 'TERMINAL' } },
        _count: true,
      }),
      this.prisma.pipelineEvent.findMany({
        take: 25,
        orderBy: { occurredAt: 'desc' },
        include: {
          staff: { select: { staffCode: true, fullName: true, series: true } },
        },
      }),
      Promise.all([
        this.prisma.staffApplicant.count({ where: baseWhere }),
        this.prisma.staffApplicant.count({
          where: { ...baseWhere, pipelineStage: { not: 'TERMINAL' } },
        }),
        this.prisma.staffApplicant.count({
          where: { ...baseWhere, pipelineStage: 'S2_VERIFY' },
        }),
        this.prisma.staffApplicant.count({
          where: { ...baseWhere, pipelineStage: 'S3_TRAIN' },
        }),
        this.prisma.staffApplicant.count({
          where: { ...baseWhere, pipelineStage: 'DEFERRED' },
        }),
        this.prisma.videoCertification.count({ where: { reviewStatus: 'PENDING' } }),
      ]),
    ]);

    const countMap = Object.fromEntries(
      stageCounts.map((s) => [s.pipelineStage, s._count]),
    );

    return {
      kpis: {
        total_staff: kpis[0],
        active_pipeline: kpis[1],
        pending_verification: kpis[2],
        training_queue: kpis[3],
        deferred_cases: kpis[4],
        pending_video: kpis[5],
      },
      funnel: PIPELINE_STAGES.map((stage) => ({
        stage,
        count: countMap[stage] ?? 0,
      })),
      seriesDistribution: seriesDist.map((s) => ({
        series: s.series,
        count: s._count,
      })),
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        staffCode: e.staff.staffCode,
        staffName: e.staff.fullName,
        series: e.staff.series,
        eventType: e.eventType,
        fromStage: e.fromStage,
        toStage: e.toStage,
        occurredAt: e.occurredAt,
        notes: e.notes,
      })),
    };
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Video Certifications (global admin view)
  // ─────────────────────────────────────────────────────────────────────────────

  async getVideoCertifications(filters?: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    return this.videoCertService.listForAdmin(filters);
  }

  async reviewVideoCertification(
    certId: string,
    reviewerId: string,
    body: { status: 'APPROVED' | 'REJECTED'; notes?: string },
  ) {
    return this.videoCertService.reviewCertification(
      certId,
      reviewerId,
      body.status,
      body.notes,
    );
  }
}
