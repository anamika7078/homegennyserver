import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
  ) {}

  // ─── API Methods (called by controller) ────────────────────────────

  /** Returns all 7 cron job definitions with schedule, description, and status */
  async getCronJobDefinitions() {
    return [
      {
        key: 'dl_expiry_check',
        name: 'DL Expiry Check',
        schedule: '0 9 * * *',
        scheduleLabel: 'daily 9am',
        description: 'Scans deployed DR staff for DL expiry within 60/30/7-day marks.',
        status: 'RUNNING',
      },
      {
        key: 'echallan_monitor',
        name: 'eChallan Monitor',
        schedule: '0 10 * * *',
        scheduleLabel: 'daily 10am',
        description: 'Daily challan scan for all deployed drivers. Triggers DR-DB review on 3+ challans.',
        status: 'RUNNING',
      },
      {
        key: 'pv_renewal_alert',
        name: 'PV Renewal Alert',
        schedule: '0 9 * * 1',
        scheduleLabel: 'every Monday',
        description: 'Deployed staff with Police Verification older than 11 months. Triggers renewal schedule.',
        status: 'RUNNING',
      },
      {
        key: 'video_cert_renewal',
        name: 'Video Cert Renewal',
        schedule: '0 9 * * 1',
        scheduleLabel: 'every Monday',
        description: 'Annual video self-certification renewal for all deployed staff.',
        status: 'RUNNING',
      },
      {
        key: 'trial_placement_check',
        name: 'Trial Placement Check',
        schedule: '0 8 * * *',
        scheduleLabel: 'daily 8am',
        description: 'Trial placements expiring within 3 days. Alerts RM and client for decision.',
        status: 'RUNNING',
      },
      {
        key: 'invoice_overdue_alert',
        name: 'Invoice Overdue Alert',
        schedule: '0 11 * * *',
        scheduleLabel: 'daily 11am',
        description: 'Pending invoices past due date. Escalates at Day 1/3/7 intervals.',
        status: 'RUNNING',
      },
      {
        key: 'upgrade_path_check',
        name: 'Upgrade Path Check',
        schedule: '0 9 1 * *',
        scheduleLabel: '1st of month',
        description: 'UC/Maid staff eligible for series upgrade after 6 months to confirmed placement.',
        status: 'RUNNING',
      },
    ];
  }

  /** Returns today's cron execution activity log */
  async getTodayActivityLog() {
    // In production, this would query an execution_logs table.
    // For now, return realistic sample data.
    return [
      {
        time: '09:00:01',
        jobKey: 'dl_expiry_check',
        jobName: 'DL Expiry Check',
        recordsScanned: '21 DR drivers',
        alertsGenerated: '1 (Ramkishan Yadav)',
        fcmSent: 3,
        status: 'OK',
      },
      {
        time: '09:01:03',
        jobKey: 'pv_renewal_alert',
        jobName: 'PV Renewal Alert',
        recordsScanned: '14 deployed staff',
        alertsGenerated: '1 (Sudha Tiwari)',
        fcmSent: 2,
        status: 'OK',
      },
      {
        time: '09:01:08',
        jobKey: 'video_cert_renewal',
        jobName: 'Video Cert Renewal',
        recordsScanned: '14 deployed staff',
        alertsGenerated: '0',
        fcmSent: 0,
        status: 'OK',
      },
      {
        time: '08:30:02',
        jobKey: 'trial_placement_check',
        jobName: 'Trial Checkin',
        recordsScanned: '5 trial placements',
        alertsGenerated: '1 (Suresh Kumar)',
        fcmSent: 3,
        status: 'OK',
      },
      {
        time: '10:00:05',
        jobKey: 'echallan_monitor',
        jobName: 'eChallan Monitor',
        recordsScanned: '21 DR drivers',
        alertsGenerated: '1 (Rajendra Prasad)',
        fcmSent: 4,
        status: 'OK',
      },
      {
        time: '11:00:03',
        jobKey: 'invoice_overdue_alert',
        jobName: 'Invoice Overdue',
        recordsScanned: '28 invoices',
        alertsGenerated: '1 (Saxena Family)',
        fcmSent: 2,
        status: 'OK',
      },
    ];
  }

  /** Returns system health overview */
  async getSystemHealth() {
    let dbOk = false;
    try {
      await this.dataSource.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }

    let queueDepth = 0;
    try {
      queueDepth = await this.notifQueue.count();
    } catch {
      queueDepth = -1;
    }

    return {
      database: dbOk ? 'HEALTHY' : 'DOWN',
      notificationQueue: { depth: queueDepth, status: queueDepth >= 0 ? 'HEALTHY' : 'DOWN' },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Manually trigger a specific cron job by key */
  async triggerJob(jobKey: string) {
    const jobMap: Record<string, () => Promise<void>> = {
      dl_expiry_check: () => this.checkDLExpiry(),
      echallan_monitor: () => this.checkEchallan(),
      pv_renewal_alert: () => this.checkPVExpiry(),
      video_cert_renewal: () => this.checkVideoCertExpiry(),
      trial_placement_check: () => this.checkTrialPlacements(),
      invoice_overdue_alert: () => this.checkOverdueInvoices(),
      upgrade_path_check: () => this.checkUpgradePaths(),
    };

    const fn = jobMap[jobKey];
    if (!fn) {
      return { success: false, message: `Unknown job key: ${jobKey}` };
    }
    await fn();
    return { success: true, message: `Job ${jobKey} triggered successfully` };
  }

  // ─── CRON 1: DL Expiry Check — daily 9am ─────────────────
  @Cron('0 9 * * *')
  async checkDLExpiry(): Promise<void> {
    this.logger.log('[CRON] Checking DL expiries...');
    const expiring: Array<{ id: string; staff_code: string; assigned_rm_id: string; expiry: string }> =
      await this.dataSource.query(`
        SELECT sa.id, sa.staff_code, sa.assigned_rm_id,
               (sa.verified_docs->>'dl_valid_to')::DATE AS expiry
        FROM staff_applicants sa
        WHERE sa.series = 'DR'
          AND sa.pipeline_stage = 'S5_DEPLOY'
          AND (sa.verified_docs->>'dl_valid_to') IS NOT NULL
          AND (sa.verified_docs->>'dl_valid_to')::DATE BETWEEN NOW() AND NOW() + INTERVAL '60 days'
      `);

    for (const staff of expiring) {
      await this.notifQueue.add('dl_expiry_alert', {
        staffId:    staff.id,
        expiryDate: staff.expiry,
        rmId:       staff.assigned_rm_id,
      });
    }
    this.logger.log(`[CRON] DL expiry: ${expiring.length} alerts queued`);
  }

  // ─── CRON 2: eChallan Monitor — daily 10am ───────────────
  @Cron('0 10 * * *')
  async checkEchallan(): Promise<void> {
    this.logger.log('[CRON] Checking eChallan updates...');
    const deployed: Array<{ id: string; staff_code: string; dl_number: string; assigned_rm_id: string }> =
      await this.dataSource.query(`
        SELECT sa.id, sa.staff_code,
               sa.verified_docs->>'dl_number' AS dl_number,
               sa.assigned_rm_id
        FROM staff_applicants sa
        WHERE sa.series = 'DR'
          AND sa.pipeline_stage = 'S5_DEPLOY'
          AND sa.verified_docs->>'dl_number' IS NOT NULL
      `);

    for (const staff of deployed) {
      if (staff.dl_number) {
        await this.notifQueue.add(
          'echallan_check',
          { staffId: staff.id, dlNumber: staff.dl_number, rmId: staff.assigned_rm_id },
          { delay: Math.random() * 60_000 },  // stagger requests
        );
      }
    }
    this.logger.log(`[CRON] eChallan: ${deployed.length} checks queued`);
  }

  // ─── CRON 3: PV Expiry Reminder — every Monday 9am ───────
  @Cron('0 9 * * 1')
  async checkPVExpiry(): Promise<void> {
    this.logger.log('[CRON] Checking PV expiries...');
    const expiring: Array<{ id: string; staff_code: string; assigned_rm_id: string; pv_date: string }> =
      await this.dataSource.query(`
        SELECT sa.id, sa.staff_code, sa.assigned_rm_id,
               (sa.verified_docs->>'pv_date')::DATE AS pv_date
        FROM staff_applicants sa
        WHERE sa.pv_status = 'CLEAR'
          AND sa.pipeline_stage = 'S5_DEPLOY'
          AND (sa.verified_docs->>'pv_date') IS NOT NULL
          AND (sa.verified_docs->>'pv_date')::DATE < NOW() - INTERVAL '11 months'
      `);

    for (const staff of expiring) {
      await this.notifQueue.add('pv_renewal_alert', {
        staffId: staff.id,
        pvDate:  staff.pv_date,
        rmId:    staff.assigned_rm_id,
      });
    }
    this.logger.log(`[CRON] PV expiry: ${expiring.length} alerts queued`);
  }

  // ─── CRON 4: Video Cert Annual Renewal — every Monday 9am ─
  @Cron('0 9 * * 1')
  async checkVideoCertExpiry(): Promise<void> {
    this.logger.log('[CRON] Checking video cert expiries...');
    const expiring: Array<{ id: string; staff_id: string; assigned_rm_id: string }> =
      await this.dataSource.query(`
        SELECT vc.id, vc.staff_id, sa.assigned_rm_id
        FROM video_certs vc
        JOIN staff_applicants sa ON sa.id = vc.staff_id
        WHERE vc.created_at < NOW() - INTERVAL '11 months'
          AND vc.never_delete = false
          AND sa.pipeline_stage = 'S5_DEPLOY'
      `);

    for (const cert of expiring) {
      await this.notifQueue.add('video_cert_renewal', {
        staffId: cert.staff_id,
        certId:  cert.id,
        rmId:    cert.assigned_rm_id,
      });
    }
    this.logger.log(`[CRON] Video cert renewals: ${expiring.length} queued`);
  }

  // ─── CRON 5: Trial Checkin — daily 8am ───────────────────
  @Cron('0 8 * * *')
  async checkTrialPlacements(): Promise<void> {
    this.logger.log('[CRON] Checking trial placements expiring soon...');
    const expiring: Array<{ id: string; staff_id: string; client_id: string; trial_end_date: string; rm_id: string }> =
      await this.dataSource.query(`
        SELECT p.id, p.staff_id, p.client_id, p.trial_end_date, p.rm_id
        FROM placements p
        WHERE p.status = 'TRIAL'
          AND p.trial_end_date IS NOT NULL
          AND p.trial_end_date BETWEEN NOW() AND NOW() + INTERVAL '3 days'
      `);

    for (const placement of expiring) {
      await this.notifQueue.add('trial_expiry_alert', {
        placementId:  placement.id,
        trialEndDate: placement.trial_end_date,
        rmId:         placement.rm_id,
      });
    }
    this.logger.log(`[CRON] Trial expiry: ${expiring.length} alerts queued`);
  }

  // ─── CRON 6: Invoice Overdue — daily 11am ────────────────
  @Cron('0 11 * * *')
  async checkOverdueInvoices(): Promise<void> {
    this.logger.log('[CRON] Checking overdue invoices...');
    const overdue: Array<{ id: string; client_id: string; total_amount: string; due_date: string }> =
      await this.dataSource.query(`
        SELECT ci.id, ci.client_id, ci.total_amount, ci.due_date
        FROM client_invoices ci
        WHERE ci.status = 'PENDING'
          AND ci.due_date < NOW()
      `);

    for (const inv of overdue) {
      await this.notifQueue.add('invoice_overdue', {
        invoiceId: inv.id,
        clientId:  inv.client_id,
        amount:    parseFloat(inv.total_amount),
      });
    }
    this.logger.log(`[CRON] Overdue invoices: ${overdue.length} alerts queued`);
  }

  // ─── CRON 7: Upgrade Path Check — 1st of each month ──────
  @Cron('0 9 1 * *')
  async checkUpgradePaths(): Promise<void> {
    this.logger.log('[CRON] Checking upgrade paths...');
    const eligible: Array<{ id: string; staff_code: string; series: string; assigned_rm_id: string }> =
      await this.dataSource.query(`
        SELECT sa.id, sa.staff_code, sa.series, sa.assigned_rm_id
        FROM staff_applicants sa
        JOIN placements p ON p.staff_id = sa.id AND p.status = 'CONFIRMED'
        WHERE sa.series IN ('UC', 'MAID')
        GROUP BY sa.id, sa.staff_code, sa.series, sa.assigned_rm_id
        HAVING MIN(p.billing_start_date) < NOW() - INTERVAL '6 months'
           AND sa.id NOT IN (
             SELECT staff_id FROM upgrade_paths WHERE status != 'EXPIRED'
           )
      `);

    for (const staff of eligible) {
      const toSeries = staff.series === 'UC' ? 'SC' : 'UC';
      await this.dataSource.query(
        `INSERT INTO upgrade_paths (staff_id, from_series, to_series, eligibility_date, status)
         VALUES ($1, $2, $3, NOW(), 'ELIGIBLE')
         ON CONFLICT DO NOTHING`,
        [staff.id, staff.series, toSeries],
      );
      await this.notifQueue.add('upgrade_eligible', {
        staffId:    staff.id,
        fromSeries: staff.series,
        toSeries,
        rmId:       staff.assigned_rm_id,
      });
    }
    this.logger.log(`[CRON] Upgrade paths: ${eligible.length} eligible`);
  }
}
