import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScenarioEngine } from './scenario.engine';
import { Series } from '../staff/staff.entity';
import { RoutingFlags } from '../pipeline/pipeline.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class ScenarioService {
  constructor(
    private readonly engine: ScenarioEngine,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  evaluate(series: Series, flags: RoutingFlags, staffId?: string, actorId?: string) {
    const code = this.engine.route(series, flags);
    const effect = this.engine.getEffect(code);

    if (staffId) {
      void this.persistTrigger(staffId, code, flags, effect, actorId);
    }

    return { code, effect };
  }

  private async persistTrigger(
    staffId: string,
    code: string,
    flags: RoutingFlags,
    effect: ReturnType<ScenarioEngine['getEffect']>,
    actorId?: string,
  ) {
    try {
      await this.prisma.scenarioLog.create({
        data: {
          staffId,
          scenarioCode: code,
          triggeredBy: actorId,
          flags: flags as object,
          escalatedToBm: effect.escalated,
          actionsTaken: [],
        },
      });

      await this.audit.log({
        actorId,
        action: AuditAction.SCENARIO_TRIGGER,
        entityType: 'staff_applicant',
        entityId: staffId,
        metadata: { scenarioCode: code, effect },
      });

      this.events.emit('scenario.triggered', { staffId, code, effect });

      if (effect.escalated) {
        await this.prisma.escalationLog.create({
          data: {
            staffId,
            severity: 'HIGH',
            scenarioCode: code,
            title: `Scenario ${code} requires BM attention`,
            description: `Auto-escalation from scenario engine`,
            status: 'OPEN',
          },
        });
      }
    } catch {
      // Tables may not exist until migration
    }
  }

  async getStaffScenarioHistory(staffId: string) {
    try {
      return this.prisma.scenarioLog.findMany({
        where: { staffId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    } catch {
      return [];
    }
  }
}
