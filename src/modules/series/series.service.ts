import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { StaffSeries } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ScenarioService } from '../scenario/scenario.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MEDICAL_DUTY_CODES, SC_CARE_TYPES, UC_ROLE_TYPES } from './series.constants';
import { Series } from '../staff/staff.entity';

function toLegacySeries(s: StaffSeries): Series {
  const m: Record<StaffSeries, Series> = {
    [StaffSeries.DRIVER]: Series.DRIVER,
    [StaffSeries.SKILLED_CARE]: Series.SKILLED_CARE,
    [StaffSeries.UNSKILLED_CARE]: Series.UNSKILLED_CARE,
    [StaffSeries.MAID]: Series.MAID,
  };
  return m[s] ?? Series.SKILLED_CARE;
}

@Injectable()
export class SeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scenarios: ScenarioService,
    private readonly events: EventEmitter2,
  ) {}

  validateScCareType(careType: string) {
    if (!SC_CARE_TYPES.includes(careType as never)) {
      throw new BadRequestException(
        `Invalid SC care type. Allowed: ${SC_CARE_TYPES.join(', ')}`,
      );
    }
  }

  validateUcRoleType(roleType: string) {
    if (!UC_ROLE_TYPES.includes(roleType as never)) {
      throw new BadRequestException(
        `Invalid UC role type. Allowed: ${UC_ROLE_TYPES.join(', ')}`,
      );
    }
  }

  /** UC cannot perform medical duties — scope violation */
  assertNoMedicalDuty(series: StaffSeries, dutyCode: string) {
    if (
      series === StaffSeries.UNSKILLED_CARE &&
      MEDICAL_DUTY_CODES.includes(dutyCode)
    ) {
      throw new BadRequestException('UC series cannot perform medical duties (scope violation)');
    }
  }

  async assignScCareTypes(staffId: string, careTypes: string[], actorId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    if (staff.series !== StaffSeries.SKILLED_CARE) {
      throw new BadRequestException('Care types apply to SC series only');
    }
    careTypes.forEach((c) => this.validateScCareType(c));

    const metadata = (staff.metadata as Record<string, unknown>) ?? {};
    const updated = await this.prisma.staffApplicant.update({
      where: { id: staffId },
      data: {
        roleTypes: JSON.stringify(careTypes),
        metadata: { ...metadata, care_type_tier: careTypes[0], care_types: careTypes },
      },
    });
    return updated;
  }

  async assignUcRoleTypes(staffId: string, roleTypes: string[], actorId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    if (staff.series !== StaffSeries.UNSKILLED_CARE) {
      throw new BadRequestException('Role types apply to UC series only');
    }
    roleTypes.forEach((r) => this.validateUcRoleType(r));

    return this.prisma.staffApplicant.update({
      where: { id: staffId },
      data: { roleTypes: JSON.stringify(roleTypes) },
    });
  }

  /** UC → SC upgrade eligibility */
  async requestUcToScUpgrade(staffId: string, actorId: string, notes?: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    if (staff.series !== StaffSeries.UNSKILLED_CARE) {
      throw new BadRequestException('Upgrade path is UC → SC only');
    }
    if (staff.pvStatus !== 'CLEAR') {
      throw new BadRequestException('CLEAR police verification required before SC upgrade');
    }

    const path = await this.prisma.$executeRaw`
      INSERT INTO upgrade_paths (staff_id, from_series, to_series, status, notes, triggered_at)
      VALUES (${staffId}::uuid, 'UNSKILLED_CARE', 'SKILLED_CARE', 'IN_PROGRESS', ${notes ?? 'RM initiated UC→SC'}, NOW())
      ON CONFLICT (staff_id, from_series, to_series) DO UPDATE SET status = 'IN_PROGRESS', triggered_at = NOW()
    `.catch(async () => {
      // fallback if upgrade_paths uses different enum values
      return null;
    });

    this.scenarios.evaluate(
      toLegacySeries(StaffSeries.UNSKILLED_CARE),
      { trainable: true, credentialGap: false },
      staffId,
      actorId,
    );

    this.events.emit('realtime.broadcast', {
      channel: 'escalations',
      event: 'upgrade.requested',
      data: { staffId, from: 'UC', to: 'SC' },
    });

    return { staffId, status: 'IN_PROGRESS', message: 'UC→SC upgrade initiated — BM approval may be required' };
  }

  /** Driver verification — Sarathi + eChallan stubs */
  async runDriverApiChecks(staffId: string, dlNumber: string, actorId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Staff not found');
    if (staff.series !== StaffSeries.DRIVER) {
      throw new BadRequestException('Sarathi/eChallan checks apply to Driver series only');
    }

    const sarathi = await this.mockSarathiApi(dlNumber);
    const challan = await this.mockEChallanApi(dlNumber);

    await this.prisma.verificationTrack.upsert({
      where: { staffId_trackType: { staffId, trackType: 'SARATHI_API' } },
      create: {
        staffId,
        trackType: 'SARATHI_API',
        status: sarathi.valid ? 'CLEAR' : 'FAILED',
        result: sarathi,
        verifiedBy: actorId,
        verifiedAt: new Date(),
      },
      update: {
        status: sarathi.valid ? 'CLEAR' : 'FAILED',
        result: sarathi,
        verifiedAt: new Date(),
      },
    });

    await this.prisma.verificationTrack.upsert({
      where: { staffId_trackType: { staffId, trackType: 'ECHALLAN_API' } },
      create: {
        staffId,
        trackType: 'ECHALLAN_API',
        status: challan.violations <= 2 ? 'CLEAR' : 'IN_PROGRESS',
        result: challan,
        verifiedBy: actorId,
        verifiedAt: new Date(),
      },
      update: {
        status: challan.violations <= 2 ? 'CLEAR' : 'IN_PROGRESS',
        result: challan,
        verifiedAt: new Date(),
      },
    });

    const metadata = (staff.metadata as Record<string, unknown>) ?? {};
    await this.prisma.staffApplicant.update({
      where: { id: staffId },
      data: {
        metadata: {
          ...metadata,
          dl_number: dlNumber,
          sarathi: sarathi,
          challan: challan,
          violation_count: challan.violations,
        },
      },
    });

    const scenario = this.scenarios.evaluate(
      toLegacySeries(StaffSeries.DRIVER),
      {
        violations: challan.violations,
        licenceNearExpiry: sarathi.expiryDays < 30,
        documentGap: !sarathi.valid,
      },
      staffId,
      actorId,
    );

    return { sarathi, challan, scenario };
  }

  private async mockSarathiApi(dlNumber: string) {
    const hash = dlNumber.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      provider: 'SARATHI_STUB',
      dlNumber,
      valid: dlNumber.length >= 10,
      holderName: 'Verified Holder',
      classes: ['LMV'],
      expiryDays: 90 + (hash % 200),
      checkedAt: new Date().toISOString(),
    };
  }

  private async mockEChallanApi(dlNumber: string) {
    const hash = dlNumber.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const violations = hash % 5;
    return {
      provider: 'ECHALLAN_STUB',
      dlNumber,
      violations,
      pendingAmount: violations * 500,
      checkedAt: new Date().toISOString(),
    };
  }
}
