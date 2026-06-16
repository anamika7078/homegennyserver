import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * AdminAuditInterceptor
 *
 * Automatically logs every mutating request (POST / PUT / PATCH / DELETE)
 * on the Admin controller into the admin_audit_logs table.
 *
 * Logged fields:
 *  - actorId     → req.user.id
 *  - action      → METHOD:PATH  (e.g. POST:/admin/users/create)
 *  - entityType  → extracted from path segment following /admin/ (e.g. "users")
 *  - entityId    → route :id param when present
 *  - payload     → full request body (sanitised of secrets)
 *  - ipAddress   → req.ip
 *  - userAgent   → User-Agent header
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private static readonly MUTATING_METHODS = new Set([
    'POST', 'PUT', 'PATCH', 'DELETE',
  ]);

  /** Fields that must never be logged in plaintext */
  private static readonly REDACTED_KEYS = new Set([
    'password', 'password_hash', 'passwordHash',
    'new_password', 'newPassword',
    'token', 'secret', 'totp', 'refresh_token', 'accessToken',
  ]);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method:  string;
      url:     string;
      body:    Record<string, unknown>;
      params:  Record<string, string>;
      user?:   { id?: string };
      ip?:     string;
      headers: Record<string, string | string[] | undefined>;
    }>();

    if (!AdminAuditInterceptor.MUTATING_METHODS.has(req.method)) {
      return next.handle();
    }

    const actorId    = req.user?.id;
    const method     = req.method;
    const url        = req.url;
    const action     = `${method}:${url}`;
    const entityId   = req.params?.id ?? undefined;
    const ipAddress  = req.ip;
    const userAgent  = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : undefined;

    // Derive entityType from the first path segment after /admin/
    const entityType = this.deriveEntityType(url);

    // Sanitise sensitive fields from request body
    const payload = this.sanitise(req.body ?? {});

    return next.handle().pipe(
      tap({
        next: () => {
          // Fire-and-forget; never block the response
          void this.prisma.adminAuditLog.create({
            data: {
              actorId:    actorId ?? null,
              action,
              entityType: entityType ?? null,
              entityId:   entityId ?? null,
              payload:    payload as any,
              ipAddress:  ipAddress ?? null,
              userAgent:  userAgent ?? null,
            },
          }).catch((err: unknown) => {
            // Non-fatal: log but never surface to client
            console.warn('[AdminAudit] Log write failed:', err);
          });
        },
      }),
    );
  }

  private deriveEntityType(url: string): string | undefined {
    // URL pattern: /api/v1/admin/<entityType>/...  OR  /api/admin/<entityType>/...
    const match = url.match(/\/admin\/([^/?]+)/);
    return match?.[1] ?? undefined;
  }

  private sanitise(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (AdminAuditInterceptor.REDACTED_KEYS.has(k)) {
        out[k] = '[REDACTED]';
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = this.sanitise(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}
