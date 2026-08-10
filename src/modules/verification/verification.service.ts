import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

export interface SarathiResult {
  dl_number: string; name: string; dob: string; valid_from: string; valid_to: string;
  status: 'VALID' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED'; vehicle_classes: string[]; raw: Record<string, any>;
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

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {}

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

  async verifyAadhaar(aadhaarNumber: string, otp: string): Promise<AadhaarResult> {
    const apiUrl = this.config.get<string>('app.uidai.apiUrl') ?? '';
    const apiKey = this.config.get<string>('app.uidai.licenseKey') ?? '';
    const mockMode = !apiKey || this.config.get('app.uidai.mockMode') === 'true';

    if (mockMode) {
      this.logger.warn('[UIDAI] Mock mode active');
      return { aadhaar_number_last4: aadhaarNumber.slice(-4), name: 'MOCK APPLICANT',
        dob: '1990-01-01', gender: 'M', address: 'Mumbai, Maharashtra',
        verified: true, raw: { mock: true } };
    }
    try {
      const res = await firstValueFrom<AxiosResponse<Record<string, unknown>>>(
        this.http.post(`${apiUrl}/v3/aadhaar/ekyc`, { uid: aadhaarNumber, otp },
          { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 })
      );
      return this.mapAadhaarResponse(res.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`UIDAI error: ${msg}`);
      throw new Error(`Aadhaar verification failed: ${msg}`);
    }
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

  private mapAadhaarResponse(data: Record<string, unknown>): AadhaarResult {
    const parts = ['house','street','loc','dist','state','pc']
      .map(k => data[k]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    return {
      aadhaar_number_last4: String(data['uid'] ?? '').slice(-4),
      name: String(data['name'] ?? ''),
      dob: String(data['dob'] ?? ''),
      gender: String(data['gender'] ?? ''),
      address: parts.join(', '),
      verified: data['authStatus'] === 'y',
      raw: data as Record<string, any>,
    };
  }
}
