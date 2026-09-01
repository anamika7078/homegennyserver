import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse, isAxiosError } from 'axios';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';

/** axios's err.message is a generic "Request failed with status code 500" —
 * the actual reason (expired OTP, insufficient Sandbox wallet balance, a
 * deprecated/blocked endpoint, etc.) is in the response body. Surface that
 * instead so a masked 500 doesn't hide what's actually wrong. */
function extractSandboxError(err: unknown): string {
  if (isAxiosError(err)) {
    const body = err.response?.data as Record<string, unknown> | undefined;
    const detail = (body?.['message'] as unknown) ?? (body?.['error'] as unknown) ?? body;
    if (detail) return typeof detail === 'string' ? detail : JSON.stringify(detail);
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface SarathiResult {
  dl_number: string; name: string; dob: string; valid_from: string; valid_to: string;
  status: 'VALID' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED'; vehicle_classes: string[]; raw: Record<string, any>;
}
export interface AadhaarOtpResult {
  reference_id: string;
  message: string;
}
export interface AadhaarResult {
  aadhaar_number_last4: string; name: string; dob: string; gender: string;
  address: string; verified: boolean; raw: Record<string, any>;
}
export interface PoliceVerificationResult {
  reference_number: string; status: 'CLEAR' | 'PENDING' | 'FAILED'; report_url?: string; submitted_at: string;
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  // Sandbox's /authenticate JWT is valid 24h — cache in memory and refresh a
  // little early rather than re-authenticating on every single KYC call.
  private sandboxToken: string | null = null;
  private sandboxTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async getSandboxToken(): Promise<string> {
    if (this.sandboxToken && Date.now() < this.sandboxTokenExpiresAt) {
      return this.sandboxToken;
    }
    const apiUrl = this.config.get<string>('app.sandboxKyc.apiUrl') ?? '';
    const apiKey = this.config.get<string>('app.sandboxKyc.apiKey') ?? '';
    const apiSecret = this.config.get<string>('app.sandboxKyc.apiSecret') ?? '';
    const apiVersion = this.config.get<string>('app.sandboxKyc.apiVersion') ?? '1.0';

    const res = await firstValueFrom<AxiosResponse<{ data?: { access_token?: string } }>>(
      this.http.post(`${apiUrl}/authenticate`, undefined, {
        headers: { 'x-api-key': apiKey, 'x-api-secret': apiSecret, 'x-api-version': apiVersion },
        timeout: 10000,
      }),
    );
    const token = res.data?.data?.access_token;
    if (!token) throw new Error('Sandbox /authenticate did not return an access_token');

    this.sandboxToken = token;
    this.sandboxTokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // refresh a bit before the real 24h expiry
    return token;
  }

  async verifyDrivingLicence(dlNumber: string, dob: string, staffId?: string): Promise<SarathiResult> {
    const apiUrl = this.config.get<string>('app.sarathi.apiUrl') ?? '';
    const apiKey = this.config.get<string>('app.sarathi.apiKey') ?? '';
    const mockMode = !apiKey || this.config.get('app.sarathi.mockMode') === 'true';

    let result: SarathiResult;
    if (mockMode) {
      this.logger.warn(`[SARATHI] Mock mode active for DL ${dlNumber}`);
      result = { dl_number: dlNumber, name: 'MOCK DRIVER', dob, valid_from: '2020-01-01',
        valid_to: '2030-01-01', status: 'VALID', vehicle_classes: ['LMV','TRANS'], raw: { mock: true } };
    } else {
      try {
        const res = await firstValueFrom<AxiosResponse<Record<string, unknown>>>(
          this.http.post(`${apiUrl}/api/v1/dl/verify`, { dl_number: dlNumber, dob },
            { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 })
        );
        result = this.mapSarathiResponse(res.data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Sarathi error DL ${dlNumber}: ${msg}`);
        result = { dl_number: dlNumber, name: '', dob, valid_from: '', valid_to: '', status: 'VALID',
          vehicle_classes: [], raw: { fallback: true, error: msg } };
      }
    }

    // Persist so deployment eligibility (Pillar 1) can be evaluated later
    // without re-calling Sarathi. Previously this result went straight back
    // to the caller and nowhere else — nothing durable recorded that a DL was
    // ever checked, so nothing could gate deployment on it.
    if (staffId) {
      const trackStatus =
        result.status === 'VALID' ? 'CLEAR' : result.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
      await this.prisma.verificationTrack.upsert({
        where: { staffId_trackType: { staffId, trackType: 'SARATHI_API' } },
        create: { staffId, trackType: 'SARATHI_API', status: trackStatus, result: result as any, verifiedAt: new Date() },
        update: { status: trackStatus, result: result as any, verifiedAt: new Date() },
      }).catch((e) => this.logger.warn(`Could not persist DL verification track: ${e.message}`));
    }

    return result;
  }

  async checkEchallan(dlNumber: string, staffId?: string): Promise<{ count: number; challans: any[] }> {
    const apiUrl = this.config.get<string>('app.sarathi.apiUrl') ?? '';
    const apiKey = this.config.get<string>('app.sarathi.apiKey') ?? '';
    const mockMode = !apiKey || this.config.get('app.sarathi.mockMode') === 'true';

    let result: { count: number; challans: any[] };
    if (mockMode) {
      result = { count: 0, challans: [] };
    } else {
      try {
        const res = await firstValueFrom<AxiosResponse<{ total?: number; challans?: any[] }>>(
          this.http.get(`${apiUrl}/api/v1/echallan/${dlNumber}`,
            { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 })
        );
        result = { count: res.data.total ?? 0, challans: res.data.challans ?? [] };
      } catch (err: unknown) {
        this.logger.error(`eChallan error: ${err instanceof Error ? err.message : String(err)}`);
        result = { count: 0, challans: [] };
      }
    }

    // Persist for the same reason as DL verification above. Threshold (>=3 =
    // severe / DR-07 in the scenario router) mirrors the existing routeScenario
    // logic in pipeline-fsm.service.ts rather than inventing a new one.
    if (staffId) {
      const trackStatus = result.count >= 3 ? 'FAILED' : 'CLEAR';
      await this.prisma.verificationTrack.upsert({
        where: { staffId_trackType: { staffId, trackType: 'ECHALLAN_API' } },
        create: { staffId, trackType: 'ECHALLAN_API', status: trackStatus, result: result as any, verifiedAt: new Date() },
        update: { status: trackStatus, result: result as any, verifiedAt: new Date() },
      }).catch((e) => this.logger.warn(`Could not persist eChallan verification track: ${e.message}`));
    }

    return result;
  }

  /**
   * Step 1/2 — Sandbox sends an OTP to the mobile number linked to this
   * Aadhaar via UIDAI and returns a `reference_id` that must be passed to
   * verifyAadhaarOtp() below along with the OTP the staff receives. Nothing
   * is persisted yet — a VerificationTrack row is only written once step 2
   * actually confirms the OTP (see verifyAadhaarOtp).
   */
  async generateAadhaarOtp(aadhaarNumber: string): Promise<AadhaarOtpResult> {
    const apiUrl = this.config.get<string>('app.sandboxKyc.apiUrl') ?? '';
    const apiVersion = this.config.get<string>('app.sandboxKyc.apiVersion') ?? '1.0';
    const apiKey = this.config.get<string>('app.sandboxKyc.apiKey') ?? '';
    const mockMode = this.config.get('app.sandboxKyc.mockMode') === true;

    if (mockMode) {
      this.logger.warn('[SANDBOX-KYC] Mock mode active — no SANDBOX_API_KEY/SANDBOX_API_SECRET configured');
      return { reference_id: `MOCK-${aadhaarNumber.slice(-4)}-${Date.now()}`, message: 'OTP sent successfully (mock)' };
    }

    try {
      const token = await this.getSandboxToken();
      const res = await firstValueFrom<AxiosResponse<{ data?: { reference_id?: number | string; message?: string } }>>(
        this.http.post(`${apiUrl}/kyc/aadhaar/okyc/otp`, {
          '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.otp.request',
          aadhaar_number: aadhaarNumber,
          consent: 'Y',
          reason: 'HomeGenny staff onboarding KYC (Pillar 1)',
        }, {
          headers: { Authorization: token, 'x-api-key': apiKey, 'x-api-version': apiVersion },
          timeout: 15000,
        }),
      );
      const data = res.data?.data;
      if (!data?.reference_id) throw new Error('Sandbox did not return a reference_id');
      return { reference_id: String(data.reference_id), message: data.message ?? 'OTP sent successfully' };
    } catch (err: unknown) {
      const msg = extractSandboxError(err);
      this.logger.error(`Sandbox Aadhaar generate-OTP error: ${msg}`);
      throw new BadRequestException(`Could not send Aadhaar OTP: ${msg}`);
    }
  }

  /**
   * Step 2/2 — verify the OTP against the reference_id from generateAadhaarOtp().
   * `aadhaarNumber` is passed through again only for the last-4-digits display
   * value below — Sandbox's verify response doesn't echo the Aadhaar number
   * back (by design, it only returns the KYC details it was asked to fetch).
   */
  async verifyAadhaarOtp(referenceId: string, otp: string, aadhaarNumber: string, staffId?: string): Promise<AadhaarResult> {
    const apiUrl = this.config.get<string>('app.sandboxKyc.apiUrl') ?? '';
    const apiVersion = this.config.get<string>('app.sandboxKyc.apiVersion') ?? '1.0';
    const apiKey = this.config.get<string>('app.sandboxKyc.apiKey') ?? '';
    const mockMode = this.config.get('app.sandboxKyc.mockMode') === true;

    let result: AadhaarResult;
    if (mockMode) {
      this.logger.warn('[SANDBOX-KYC] Mock mode active');
      result = { aadhaar_number_last4: aadhaarNumber.slice(-4), name: 'MOCK APPLICANT',
        dob: '1990-01-01', gender: 'M', address: 'Mumbai, Maharashtra',
        verified: true, raw: { mock: true, reference_id: referenceId } };
    } else {
      try {
        const token = await this.getSandboxToken();
        const res = await firstValueFrom<AxiosResponse<{ data?: Record<string, unknown> }>>(
          this.http.post(`${apiUrl}/kyc/aadhaar/okyc/otp/verify`, {
            '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.request',
            reference_id: referenceId,
            otp,
          }, {
            headers: { Authorization: token, 'x-api-key': apiKey, 'x-api-version': apiVersion },
            timeout: 15000,
          }),
        );
        result = this.mapAadhaarResponse(res.data?.data ?? {}, aadhaarNumber);
      } catch (err: unknown) {
        const msg = extractSandboxError(err);
        this.logger.error(`Sandbox Aadhaar verify-OTP error: ${msg}`);
        throw new BadRequestException(`Aadhaar verification failed: ${msg}`);
      }
    }

    // Persist for the same reason DL/eChallan do — without this, an RM
    // "verifying" Aadhaar left no durable trace anything else (incl.
    // deployment-eligibility checks) could read back.
    if (staffId) {
      const trackStatus = result.verified ? 'CLEAR' : 'FAILED';
      await this.prisma.verificationTrack.upsert({
        where: { staffId_trackType: { staffId, trackType: 'AADHAAR_EKYC' } },
        create: { staffId, trackType: 'AADHAAR_EKYC', status: trackStatus, result: result as any, verifiedAt: new Date() },
        update: { status: trackStatus, result: result as any, verifiedAt: new Date() },
      }).catch((e) => this.logger.warn(`Could not persist Aadhaar verification track: ${e.message}`));
    }

    return result;
  }

  async submitPoliceVerification(staffId: string, details: Record<string, any>): Promise<PoliceVerificationResult> {
    const ref = `PV-${staffId.slice(0, 8).toUpperCase()}-${Date.now()}`;
    const res: PoliceVerificationResult = { reference_number: ref, status: 'PENDING', submitted_at: new Date().toISOString() };
    await this.prisma.verificationTrack.upsert({
      where: {
        staffId_trackType: {
          staffId,
          trackType: 'POLICE_VERIFICATION',
        },
      },
      create: {
        staffId,
        trackType: 'POLICE_VERIFICATION',
        status: 'PENDING',
        result: res as any,
        notes: details?.notes || 'Police verification submitted',
        verifiedAt: new Date(),
      },
      update: {
        status: 'PENDING',
        result: res as any,
        notes: details?.notes || 'Police verification resubmitted',
        verifiedAt: new Date(),
      },
    }).catch(() => {});
    return res;
  }

  /**
   * Closes out a previously-submitted PV request with a real result. This is the missing half of
   * the PV workflow: submitPoliceVerification() above only ever writes VerificationTrack.status =
   * 'PENDING' — nothing anywhere used to move it forward. Worse, the field the S5_DEPLOY gate
   * actually reads (StaffApplicant.pvStatus, in pipeline-fsm.service.ts's
   * checkDeploymentEligibility()) is a completely separate column with no code linking it to
   * VerificationTrack — a PV could sit PENDING forever while pvStatus quietly stayed
   * NOT_INITIATED, or vice versa. This method is the one place both fields get written together,
   * atomically, so they can't drift apart again.
   */
  async closePoliceVerification(
    staffId: string,
    result: 'CLEAR' | 'ADVERSE',
    notes: string | undefined,
    actorId: string | undefined,
  ) {
    if (result !== 'CLEAR' && result !== 'ADVERSE') {
      throw new BadRequestException("result must be exactly 'CLEAR' or 'ADVERSE'");
    }

    const existing = await this.prisma.verificationTrack.findUnique({
      where: { staffId_trackType: { staffId, trackType: 'POLICE_VERIFICATION' } },
    });
    if (!existing) {
      throw new BadRequestException(
        'PV was never submitted for this staff — call POST /verification/pv/submit/:staffId first',
      );
    }

    // VerificationTrackStatus has no ADVERSE member (its closest equivalent is FAILED); PvStatus
    // has no FAILED member (its closest equivalent is ADVERSE). Map explicitly rather than
    // reusing one enum's string for the other.
    const trackStatus = result === 'CLEAR' ? 'CLEAR' : 'FAILED';
    const closedAt = new Date();

    const [track] = await this.prisma.$transaction([
      this.prisma.verificationTrack.update({
        where: { staffId_trackType: { staffId, trackType: 'POLICE_VERIFICATION' } },
        data: {
          status: trackStatus,
          result: { ...(existing.result as object), status: result, closed_at: closedAt.toISOString() } as any,
          notes: notes || `Police verification closed as ${result}`,
          verifiedBy: actorId,
          verifiedAt: closedAt,
        },
      }),
      this.prisma.staffApplicant.update({
        where: { id: staffId },
        data: { pvStatus: result },
      }),
    ]);

    await this.audit.log({
      actorId,
      action: result === 'CLEAR' ? AuditAction.APPROVAL : AuditAction.DENIAL,
      entityType: 'police_verification',
      entityId: staffId,
      metadata: { result, notes },
    });

    return { staff_id: staffId, pv_status: result, track_status: track.status, closed_at: closedAt.toISOString() };
  }

  async submitMedicalVerification(staffId: string, details: Record<string, any>) {
    const result = {
      status: details.passed ? 'CLEAR' : 'FAILED',
      notes: details.notes || '',
      date: new Date().toISOString(),
    };
    
    await this.prisma.verificationTrack.upsert({
      where: {
        staffId_trackType: {
          staffId,
          trackType: 'HEALTH_SCREENING',
        },
      },
      create: {
        staffId,
        trackType: 'HEALTH_SCREENING',
        status: details.passed ? 'CLEAR' : 'FAILED',
        result,
        verifiedBy: details.verifiedBy || null,
        notes: details.notes,
        verifiedAt: new Date(),
      },
      update: {
        status: details.passed ? 'CLEAR' : 'FAILED',
        result,
        verifiedBy: details.verifiedBy || null,
        notes: details.notes,
        verifiedAt: new Date(),
      },
    });
    
    return result;
  }

  /**
   * Every verify-action above (aadhaar/dl/echallan/pv/medical) persists a VerificationTrack
   * row, but until now there was no way to read it back — an RM navigating away from a
   * verification screen had no way to reconstruct what was already checked. Mirrors the
   * REQUIRED_VERIFICATION_TRACKS logic already used in staff-mobile.controller.ts so RM and
   * Staff see the same "what's required for this series" signal.
   */
  async getStatusForStaff(staffId: string) {
    const staff = await this.prisma.staffApplicant.findUnique({
      where: { id: staffId },
      select: { series: true, verificationTracks: true },
    });
    if (!staff) return null;

    const TRACK_LABELS: Record<string, string> = {
      AADHAAR_EKYC: 'aadhaar',
      SARATHI_API: 'dl',
      ECHALLAN_API: 'echallan',
      POLICE_VERIFICATION: 'pv',
      HEALTH_SCREENING: 'medical',
    };
    // Keyed by the StaffSeries enum values actually stored on staff.series
    // (MAID/SKILLED_CARE/UNSKILLED_CARE/DRIVER) — NOT the DR/SC/UC short codes
    // the mobile app displays. Keying this by the short codes previously made
    // every lookup below miss for non-MAID series, silently returning
    // `required: []` and making `all_required_clear` vacuously true.
    const REQUIRED_BY_SERIES: Record<string, string[]> = {
      DRIVER: ['AADHAAR_EKYC', 'SARATHI_API', 'ECHALLAN_API', 'POLICE_VERIFICATION', 'HEALTH_SCREENING'],
      SKILLED_CARE: ['AADHAAR_EKYC', 'POLICE_VERIFICATION', 'HEALTH_SCREENING'],
      UNSKILLED_CARE: ['AADHAAR_EKYC', 'POLICE_VERIFICATION'],
      MAID: ['AADHAAR_EKYC', 'POLICE_VERIFICATION'],
    };

    const bySlug = new Map(staff.verificationTracks.map((t) => [TRACK_LABELS[t.trackType] ?? t.trackType, t]));
    const required = REQUIRED_BY_SERIES[staff.series] ?? [];

    const tracks = Object.entries(TRACK_LABELS).map(([trackType, slug]) => {
      const row = bySlug.get(slug);
      return {
        track: slug,
        track_type: trackType,
        required: required.includes(trackType),
        status: row?.status ?? 'NOT_STARTED',
        verified_at: row?.verifiedAt ?? null,
        notes: row?.notes ?? null,
        // Raw verify-call payload (e.g. Aadhaar's name/dob/address), so a
        // screen re-opened after a track already cleared can show what was
        // verified instead of re-prompting for input it already has.
        result: row?.result ?? null,
      };
    });

    const allRequiredClear = required.every((t) => bySlug.get(TRACK_LABELS[t])?.status === 'CLEAR');

    return { staff_id: staffId, series: staff.series, tracks, all_required_clear: allRequiredClear };
  }

  private mapSarathiResponse(data: Record<string, unknown>): SarathiResult {
    return {
      dl_number: String(data['dlNumber'] ?? data['dl_number'] ?? ''),
      name: String(data['holderName'] ?? data['name'] ?? ''),
      dob: String(data['dob'] ?? data['dateOfBirth'] ?? ''),
      valid_from: String(data['issueDate'] ?? data['valid_from'] ?? ''),
      valid_to: String(data['expiryDate'] ?? data['valid_to'] ?? ''),
      status: (String(data['dlStatus'] ?? 'VALID').toUpperCase()) as SarathiResult['status'],
      vehicle_classes: (data['vehicleClasses'] as string[] | undefined) ?? [],
      raw: data as Record<string, any>,
    };
  }

  /** Maps Sandbox's real /kyc/aadhaar/okyc/otp/verify response shape. */
  private mapAadhaarResponse(data: Record<string, unknown>, aadhaarNumber: string): AadhaarResult {
    return {
      aadhaar_number_last4: aadhaarNumber.slice(-4),
      name: String(data['name'] ?? ''),
      dob: String(data['date_of_birth'] ?? data['year_of_birth'] ?? ''),
      gender: String(data['gender'] ?? ''),
      address: String(data['full_address'] ?? ''),
      verified: data['status'] === 'VALID',
      raw: data as Record<string, any>,
    };
  }
}
