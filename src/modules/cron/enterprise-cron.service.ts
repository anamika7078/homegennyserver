import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EnterpriseCronService {
  private readonly logger = new Logger(EnterpriseCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async trialExpiryReminders() {
    const rows = await this.dataSource.query(`
      SELECT p.id, p.trial_end_date, sa.staff_code, sa.full_name
      FROM placements p
      JOIN staff_applicants sa ON sa.id = p.staff_id
      WHERE p.status = 'TRIAL'
        AND p.trial_end_date IS NOT NULL
        AND p.trial_end_date <= CURRENT_DATE + INTERVAL '3 days'
    `).catch(() => []);
    if (rows.length) {
      this.logger.log(`Trial expiry reminders: ${rows.length} placements`);
      this.events.emit('cron.trial_expiry', rows);
      this.events.emit('realtime.broadcast', {
        channel: 'cron',
        event: 'cron.trial_expiry',
        data: { count: rows.length },
      });
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async pvRenewalCheck() {
    const rows = await this.dataSource.query(`
      SELECT id, staff_code, full_name, pv_status
      FROM staff_applicants
      WHERE pv_status IN ('EXPIRED', 'IN_PROGRESS')
        AND pipeline_stage IN ('S5_DEPLOY', 'S2_VERIFY')
    `).catch(() => []);
    if (rows.length) this.events.emit('cron.pv_renewal', rows);
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async dailyDeploymentChecks() {
    const rows = await this.dataSource.query(`
      SELECT d.id, d.staff_id, d.trial_end_date
      FROM deployments d
      WHERE d.status = 'TRIAL'
        AND d.daily_log_required = true
        AND NOT EXISTS (
          SELECT 1 FROM care_logs cl
          WHERE cl.deployment_id = d.id AND cl.log_date = CURRENT_DATE
        )
    `).catch(() => []);
    if (rows.length) {
      this.logger.warn(`Missing daily care logs: ${rows.length} deployments`);
      this.events.emit('cron.missing_daily_logs', rows);
    }
  }

  @Cron(CronExpression.EVERY_WEEK)
  async videoCertRenewal() {
    this.events.emit('cron.video_cert_renewal', { checkedAt: new Date() });
  }

  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async invoiceReminders() {
    const rows = await this.dataSource.query(`
      SELECT id, invoice_number, due_date, total_amount
      FROM client_invoices
      WHERE status = 'PENDING' AND due_date <= CURRENT_DATE + INTERVAL '7 days'
    `).catch(() => []);
    if (rows.length) this.events.emit('cron.invoice_reminder', rows);
  }

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async deferredTimeoutCheck() {
    const rows = await this.dataSource.query(`
      SELECT dr.id, dr.staff_id, sa.staff_code, sa.full_name
      FROM deferred_records dr
      JOIN staff_applicants sa ON sa.id = dr.staff_id
      WHERE sa.pipeline_stage = 'DEFERRED'
        AND dr.timeout_at IS NOT NULL
        AND dr.timeout_at < NOW()
        AND dr.resume_at IS NULL
    `).catch(() => []);

    for (const row of rows) {
      await this.dataSource.query(
        `UPDATE staff_applicants SET pipeline_stage = 'TERMINAL', terminal_outcome = 'DEFERRED', updated_at = NOW()
         WHERE id = $1`,
        [row.staff_id],
      );
      await this.dataSource.query(
        `INSERT INTO pipeline_events (staff_id, event_type, from_stage, to_stage, reason_code, payload)
         VALUES ($1, 'DEFERRED_TIMEOUT', 'DEFERRED', 'TERMINAL', '90_DAY_TIMEOUT', '{}')`,
        [row.staff_id],
      );
    }

    if (rows.length) {
      this.logger.warn(`Deferred timeout → terminal: ${rows.length} staff`);
      this.events.emit('cron.deferred_timeout', rows);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async dlExpiryAlerts() {
    const rows = await this.dataSource.query(`
      SELECT sa.id, sa.staff_code, sa.full_name
      FROM staff_applicants sa
      JOIN verification_tracks vt ON vt.staff_id = sa.id
      WHERE vt.track_type = 'SARATHI_API'
        AND vt.expires_at IS NOT NULL
        AND vt.expires_at <= CURRENT_DATE + INTERVAL '30 days'
        AND sa.pipeline_stage NOT IN ('TERMINAL')
    `).catch(() => []);
    if (rows.length) this.events.emit('cron.dl_expiry', rows);
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async escalationFollowUps() {
    const rows = await this.dataSource.query(`
      SELECT id, title, severity, created_at
      FROM escalation_logs
      WHERE status = 'OPEN' AND created_at < NOW() - INTERVAL '24 hours'
    `).catch(() => []);
    if (rows.length) this.events.emit('cron.escalation_followup', rows);
  }

  // ── HR Alerts & Expiries Daily Checks ──────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async checkHrDocumentExpiries() {
    this.logger.log('[CRON] Running HR document expiry checks...');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fetch all active employee documents that have expiry dates
    const docs = await this.prisma.employeeDocument.findMany({
      where: {
        employee: { deletedAt: null },
        validTill: { not: null },
      },
      include: { employee: true },
    });

    for (const doc of docs) {
      if (!doc.validTill) continue;
      const expiry = new Date(doc.validTill);
      expiry.setHours(0, 0, 0, 0);

      const diffTime = expiry.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // Calculate status change
      let newStatus = 'Verified';
      if (diffDays < 0) {
        newStatus = 'Expired';
      } else if (diffDays <= 30) {
        newStatus = 'Expiring Soon';
      }

      if (newStatus !== doc.status) {
        await this.prisma.employeeDocument.update({
          where: { id: doc.id },
          data: { status: newStatus },
        });
      }

      // Check notification conditions: 30, 15, 7 days before, on expiry, and after expiry
      const employeeName = doc.employee.fullName;
      const docType = doc.type;
      let shouldNotify = false;
      let alertMsg = '';

      if (diffDays === 30) {
        shouldNotify = true;
        alertMsg = `${docType} for employee ${employeeName} expires in 30 days.`;
      } else if (diffDays === 15) {
        shouldNotify = true;
        alertMsg = `${docType} for employee ${employeeName} expires in 15 days.`;
      } else if (diffDays === 7) {
        shouldNotify = true;
        alertMsg = `URGENT: ${docType} for employee ${employeeName} expires in 7 days.`;
      } else if (diffDays === 0) {
        shouldNotify = true;
        alertMsg = `EXPIRED: ${docType} for employee ${employeeName} has expired today!`;
      } else if (diffDays < 0) {
        // Send alert after expiry until renewed
        shouldNotify = true;
        alertMsg = `EXPIRED REMINDER: ${docType} for employee ${employeeName} is expired. Please renew.`;
      }

      if (shouldNotify) {
        await this.notifications.createInAppNotification(
          `${docType} Expiry Alert`,
          alertMsg,
          null, // General HR notification
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkHrMissingDocumentsAndEvents() {
    this.logger.log('[CRON] Running HR missing documents and birthdays/anniversaries checks...');
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentDate = today.getDate();

    const employees = await this.prisma.employee.findMany({
      where: { deletedAt: null },
      include: { category: true },
    });

    for (const emp of employees) {
      // 1. Birthdays
      if (emp.dateOfBirth) {
        const dob = new Date(emp.dateOfBirth);
        if (dob.getMonth() === currentMonth && dob.getDate() === currentDate) {
          await this.notifications.createInAppNotification(
            'Employee Birthday Alert',
            `Happy Birthday to ${emp.fullName} (${emp.employeeId}) today!`,
            null,
          );
        }
      }

      // 2. Work Anniversaries
      if (emp.joiningDate) {
        const join = new Date(emp.joiningDate);
        if (join.getMonth() === currentMonth && join.getDate() === currentDate) {
          const years = today.getFullYear() - join.getFullYear();
          if (years > 0) {
            await this.notifications.createInAppNotification(
              'Work Anniversary Alert',
              `Happy Work Anniversary to ${emp.fullName} (${emp.employeeId}) for completing ${years} year(s) of service!`,
              null,
            );
          }
        }
      }

      // 3. Missing Mandatory Documents
      const mandatory = this.getMandatoryTypes(emp.category.name);
      const docs = await this.prisma.employeeDocument.findMany({
        where: { employeeId: emp.id },
      });
      const uploadedTypes = docs.map((d) => d.type);
      const missing = mandatory.filter((m) => !uploadedTypes.includes(m));

      if (missing.length > 0) {
        await this.notifications.createInAppNotification(
          'Missing Documents Alert',
          `Employee ${emp.fullName} (${emp.employeeId}) is missing mandatory documents: ${missing.join(', ')}`,
          null,
        );
      }
    }
  }

  @Cron('0 20 * * *') // Run daily at 8:00 PM
  async checkUnmarkedAttendance() {
    this.logger.log('[CRON] Checking unmarked attendance...');
    const today = new Date();
    const start = new Date(today.setHours(0, 0, 0, 0));
    const end = new Date(today.setHours(23, 59, 59, 999));

    // Fetch all active employees
    const employees = await this.prisma.employee.findMany({
      where: { deletedAt: null, status: 'Active' },
    });

    for (const emp of employees) {
      const attendance = await this.prisma.employeeAttendance.findFirst({
        where: {
          employeeId: emp.id,
          date: { gte: start, lte: end },
        },
      });

      if (!attendance) {
        await this.notifications.createInAppNotification(
          'Attendance Warning',
          `Attendance not marked today for employee ${emp.fullName} (${emp.employeeId}).`,
          null,
        );
      }
    }
  }

  private getMandatoryTypes(categoryName: string): string[] {
    const common = ['Aadhaar Card', 'Passport Size Photo', 'Police Verification Certificate'];
    const standard = ['Aadhaar Card', 'PAN Card', 'Passport Size Photo', 'Police Verification Certificate'];

    switch (categoryName) {
      case 'Driver':
        return [...standard, 'Driving License'];
      case 'Maid':
        return common;
      case 'Caretaker':
        return [...standard, 'Medical Certificate'];
      case 'Cook':
      case 'Security Guard':
      default:
        return standard;
    }
  }
}
