import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationChannel } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { NotificationsService } from './notifications.service';

export interface DispatchPayload {
  channels: Array<'SMS' | 'EMAIL' | 'WHATSAPP' | 'PUSH' | 'IN_APP'>;
  event: string;
  phone?: string;
  email?: string;
  userId?: string;
  fcmToken?: string;
  data: Record<string, string>;
}

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private mailer!: nodemailer.Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly legacy: NotificationsService,
  ) {
    this.mailer = nodemailer.createTransport({
      host: this.config.get('app.smtp.host', 'smtp.ethereal.email'),
      port: this.config.get<number>('app.smtp.port', 587),
      auth: {
        user: this.config.get('app.smtp.user'),
        pass: this.config.get('app.smtp.pass'),
      },
    });
  }

  @OnEvent('notification.dispatch')
  async dispatch(payload: DispatchPayload) {
    const body = this.formatMessage(payload.event, payload.data);

    for (const channel of payload.channels) {
      try {
        switch (channel) {
          case 'SMS':
            await this.sendSms(payload.phone, body, payload.event);
            break;
          case 'WHATSAPP':
            await this.sendWhatsApp(payload.phone, body, payload.event);
            break;
          case 'EMAIL':
            if (payload.email) await this.sendEmail(payload.email, payload.event, body);
            break;
          case 'PUSH':
            if (payload.fcmToken) {
              await this.legacy.sendFcmPush(payload.fcmToken, payload.event, body, payload.data);
            }
            break;
          case 'IN_APP':
            if (payload.userId) {
              await this.prisma.notification.create({
                data: {
                  userId: payload.userId,
                  channel: NotificationChannel.IN_APP,
                  title: payload.event.replace(/_/g, ' '),
                  body,
                  template: payload.event,
                  payload: payload.data,
                  status: 'SENT',
                  sentAt: new Date(),
                },
              });
            }
            break;
        }
      } catch (err) {
        this.logger.warn(`Channel ${channel} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.logger.log(`Dispatched ${payload.event} via ${payload.channels.join(',')}`);
  }

  private formatMessage(event: string, data: Record<string, string>) {
    if (event === 'AGREEMENT_ESIGN_OTP') {
      return `HomeGenny: Your OTP for ${data.agreement_type} is ${data.otp}. Valid ${data.expires_in_minutes} min.`;
    }
    return `HomeGenny alert: ${event}`;
  }

  private async sendSms(phone: string | undefined, body: string, template: string) {
    if (!phone) return;
    const provider = this.config.get('app.sms.provider', 'console');
    if (provider === 'msg91' && this.config.get('app.sms.apiKey')) {
      this.logger.log(`[MSG91] → ${phone}: ${body.slice(0, 40)}…`);
    } else {
      this.logger.log(`[SMS_STUB] ${phone}: ${body}`);
    }
    await this.logChannel(phone, 'SMS', template, body);
  }

  private async sendWhatsApp(phone: string | undefined, body: string, template: string) {
    if (!phone) return;
    const provider = this.config.get('app.whatsapp.provider', 'console');
    this.logger.log(`[WHATSAPP_${provider}] ${phone}: ${body.slice(0, 60)}…`);
    await this.logChannel(phone, 'WHATSAPP', template, body);
  }

  private async sendEmail(to: string, subject: string, text: string) {
    try {
      await this.mailer.sendMail({
        from: this.config.get('app.smtp.from', 'noreply@homegenny.com'),
        to,
        subject: `HomeGenny — ${subject.replace(/_/g, ' ')}`,
        text,
      });
      await this.logChannel(to, 'EMAIL', subject, text);
    } catch (err) {
      this.logger.warn(`Email failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async logChannel(recipient: string, channel: string, template: string, body: string) {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO notification_logs (recipient, channel, template, payload, status, sent_at)
        VALUES (${recipient}, ${channel}, ${template}, ${JSON.stringify({ body })}::jsonb, 'SENT', NOW())
      `;
    } catch {
      // table may not exist in minimal DB
    }
  }
}
