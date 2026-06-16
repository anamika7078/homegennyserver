import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class EnterpriseCronService {
  private readonly logger = new Logger(EnterpriseCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
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
}
