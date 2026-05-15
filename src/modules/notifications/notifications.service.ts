import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import { NotificationLog } from './notification-log.entity';

// ── Message Templates ─────────────────────────────────────────────────────────
const TEMPLATES: Record<string, (d: Record<string, string>) => string> = {
  DL_EXPIRY_30D:         (d) => `HomeGenny: Your DL (${d['dl_number']}) expires ${d['expiry_date']}. Please renew immediately.`,
  DL_EXPIRY_7D_URGENT:   (d) => `URGENT: Your DL expires in 7 days (${d['expiry_date']}). Deployment will be SUSPENDED if not renewed.`,
  PV_EXPIRY_REMINDER:    ()  => `HomeGenny: Your Police Verification expires in ~2 months. Initiate re-verification with your RM.`,
  VIDEO_CERT_ANNUAL_DUE: ()  => `HomeGenny: Your annual Video Self-Certification is due. Contact your RM.`,
  INVOICE_DUE_SOON:      (d) => `HomeGenny Invoice due in 5 days. Amount: Rs.${d['total_due']}. Due: ${d['due_date']}.`,
  INVOICE_OVERDUE_15D:   (d) => `HomeGenny Invoice OVERDUE ${d['days_overdue']} days. Amount: Rs.${d['total_due']}. Pay immediately.`,
  SALARY_DISPATCHED:     (d) => `HomeGenny Salary Credited: Rs.${d['amount']} for ${d['month']}. View payslip in the app.`,
  TRIAL_CONFIRMED:       ()  => `HomeGenny: Your trial period confirmed! Welcome to your permanent placement.`,
};

export interface NotificationPayload {
  event:      string;
  staffId?:   string;
  clientId?:  string;
  fcmToken?:  string;
  email?:     string;
  data:       Record<string, string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private mailer!: nodemailer.Transporter;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(NotificationLog) private readonly logRepo: Repository<NotificationLog>,
  ) {
    // ── Firebase Admin (GCP ADC — no key file on GCE) ──────────────────────
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: configService.get<string>('GCP_PROJECT_ID'),
      });
    }

    // ── SendGrid SMTP ───────────────────────────────────────────────────────
    this.mailer = nodemailer.createTransport({
      host: configService.get('SMTP_HOST', 'smtp.sendgrid.net'),
      port: configService.get<number>('SMTP_PORT', 587),
      auth: {
        user: configService.get('SMTP_USER', 'apikey'),
        pass: configService.get('SMTP_PASS'),
      },
    });
  }

  @OnEvent('notification.send')
  async handleNotificationEvent(payload: NotificationPayload): Promise<void> {
    const templateFn = TEMPLATES[payload.event];
    if (!templateFn) {
      this.logger.warn(`No template for event: ${payload.event}`);
      return;
    }
    const message = templateFn(payload.data);

    if (payload.fcmToken) {
      await this.sendFcmPush(payload.fcmToken, payload.event, message, payload.data);
    }
    if (payload.email && ['INVOICE_OVERDUE_15D', 'SALARY_DISPATCHED'].includes(payload.event)) {
      await this.sendEmail(payload.email, payload.event, message);
    }
  }

  async sendFcmPush(
    fcmToken: string,
    event: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    const log = await this.logRepo.save(
      this.logRepo.create({ recipient: fcmToken, channel: 'FCM', template: event,
        payload: { body }, status: 'PENDING' }),
    );

    try {
      const response = await admin.messaging().send({
        token: fcmToken,
        notification: { title: 'HomeGenny', body },
        data: { event, ...data },
        android: {
          priority: 'high',
          notification: { channelId: 'homegenny_alerts', sound: 'default' },
        },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      await this.logRepo.update(log.id, { status: 'SENT', sent_at: new Date() });
      this.logger.log(`[FCM] Push sent: ${event} -> ${response}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logRepo.update(log.id, { status: 'FAILED', error: msg });
      this.logger.error(`[FCM] Push failed ${event}: ${msg}`);
    }
  }

  async sendTopicPush(topic: string, event: string, body: string): Promise<void> {
    try {
      await admin.messaging().send({
        topic,
        notification: { title: 'HomeGenny', body },
        data: { event },
        android: { priority: 'high' },
      });
      this.logger.log(`[FCM] Topic push sent to ${topic}: ${event}`);
    } catch (err: unknown) {
      this.logger.error(`[FCM] Topic push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async sendEmail(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mailer.sendMail({
        from: this.configService.get('EMAIL_FROM', 'noreply@homegenny.com'),
        to,
        subject: `HomeGenny — ${subject.replace(/_/g, ' ')}`,
        text,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#1A3A5C;">HomeGenny</h2><hr/>
          <p style="font-size:15px;line-height:1.7;color:#333;">${text.replace(/\n/g, '<br/>')}</p>
          <hr/><p style="font-size:12px;color:#999;">HomeGenny Domestic Staffing. Automated.</p>
        </div>`,
      });
      this.logger.log(`[EMAIL] Sent to ${to}: ${subject}`);
    } catch (err: unknown) {
      this.logger.error(`[EMAIL] Failed to ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
