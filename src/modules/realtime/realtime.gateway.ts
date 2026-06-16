import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  namespace: '/events',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers.authorization?.replace('Bearer ', '') ?? '');
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwt.verify(token, {
        secret: this.config.getOrThrow<string>('app.jwt.secret'),
      });
      const role = (payload as { role?: string }).role ?? 'RM';
      client.join(`role:${role}`);
      client.join('broadcast');
      this.logger.log(`WS connected: ${(payload as { sub?: string }).sub} (${role})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`WS disconnected: ${client.id}`);
  }

  @OnEvent('realtime.broadcast')
  handleBroadcast(payload: { channel: string; event: string; data: unknown }) {
    this.server.to('broadcast').emit(payload.event, {
      channel: payload.channel,
      ...((typeof payload.data === 'object' && payload.data) || {}),
      at: new Date().toISOString(),
    });
  }

  @OnEvent('scenario.triggered')
  handleScenario(payload: { staffId: string; code: string; effect: unknown }) {
    this.server.to('broadcast').emit('scenario.triggered', payload);
    this.server.to('role:BM').emit('escalation.alert', payload);
  }

  @OnEvent('cron.trial_expiry')
  handleTrialExpiry(rows: unknown[]) {
    this.server.to('broadcast').emit('cron.trial_expiry', { count: rows.length, rows });
  }

  @OnEvent('cron.missing_daily_logs')
  handleMissingLogs(rows: unknown[]) {
    this.server.to('role:RM').emit('cron.missing_daily_logs', { count: rows.length, rows });
    this.server.to('role:BM').emit('cron.missing_daily_logs', { count: rows.length, rows });
  }

  @OnEvent('cron.escalation_followup')
  handleEscalationFollowup(rows: unknown[]) {
    this.server.to('role:BM').emit('cron.escalation_followup', { count: rows.length, rows });
  }
}
