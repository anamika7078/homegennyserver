import { Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { VerificationService } from './verification.service';

// Spec: DL/Aadhaar Verify (Pillar 1) and PV/Medical (Pillars 3/4) — RM=Y, Admin=Y,
// Staff/Client/Finance=no access. Confirmed live in the audit: POST /verification/dl
// returned 201 for STAFF, CLIENT and FINANCE tokens before this fix.
@ApiTags('Verification', 'Mobile App RM APIs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ADMIN)
@Controller({ path: 'verification', version: '1' })
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Get(':staffId')
  @ApiOperation({
    summary: 'Read back all 5 verification track statuses for a staff member',
    description:
      'Aggregates every VerificationTrack row (aadhaar/dl/echallan/pv/medical) persisted by the ' +
      'verify-action endpoints below, plus which tracks are actually required for this staff\'s ' +
      'series. Previously there was no way to read this back after navigating away from the ' +
      'verification screen — only POST actions existed.',
  })
  @ApiParam({ name: 'staffId', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' })
  async getStatus(@Param('staffId') staffId: string) {
    const status = await this.verificationService.getStatusForStaff(staffId);
    if (!status) throw new NotFoundException('Staff not found');
    return status;
  }

  @Post('dl')
  @ApiOperation({
    summary: 'Verify driving licence via Sarathi API',
    description: '⚠️ Mock mode active (no SARATHI_API_KEY configured) — always returns a deterministic VALID mock result and persists it to VerificationTrack.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['dl_number', 'dob'],
      properties: {
        dl_number: { type: 'string', example: 'DL-1420110012345' },
        dob: { type: 'string', example: '1992-03-15' },
        staff_id: { type: 'string', description: 'Pass this so the result is persisted to VerificationTrack', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' },
      },
    },
  })
  async verifyDL(@Body() body: { dl_number: string; dob: string; staff_id?: string }) {
    return this.verificationService.verifyDrivingLicence(body.dl_number, body.dob, body.staff_id);
  }

  @Post('echallan/:dlNumber')
  @ApiOperation({
    summary: 'Check eChallan violations for a DL',
    description: '⚠️ Mock mode active — always returns { count: 0, challans: [] } and persists CLEAR to VerificationTrack.',
  })
  @ApiParam({ name: 'dlNumber', example: 'DL-1420110012345' })
  @ApiQuery({ name: 'staff_id', required: false, description: 'Pass this so the result is persisted to VerificationTrack', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' })
  async checkEchallan(@Param('dlNumber') dlNumber: string, @Query('staff_id') staffId?: string) {
    return this.verificationService.checkEchallan(dlNumber, staffId);
  }

  @Post('aadhaar')
  @ApiOperation({
    summary: 'Verify Aadhaar via UIDAI API',
    description: '⚠️ Mock mode active (no UIDAI_LICENSE_KEY configured) — always returns a deterministic verified mock result and persists it to VerificationTrack.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['aadhaar_number', 'otp'],
      properties: {
        aadhaar_number: { type: 'string', example: '999988887777' },
        otp: { type: 'string', example: '123456', description: 'Any value accepted in mock mode' },
        staff_id: { type: 'string', description: 'Pass this so the result is persisted to VerificationTrack', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' },
      },
    },
  })
  async verifyAadhaar(@Body() body: { aadhaar_number: string; otp: string; staff_id?: string }) {
    return this.verificationService.verifyAadhaar(body.aadhaar_number, body.otp, body.staff_id);
  }

  @Post('pv/submit/:staffId')
  @ApiOperation({ summary: 'Submit police verification request (real — always creates a PENDING VerificationTrack record)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { notes: { type: 'string', example: 'Submitted at local police station' } },
    },
  })
  async submitPV(@Param('staffId') staffId: string, @Body() details: any) {
    return this.verificationService.submitPoliceVerification(staffId, details);
  }

  @Post('medical/submit/:staffId')
  @ApiOperation({ summary: 'Submit medical/sobriety test results (real — CLEAR/FAILED based on `passed`)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['passed'],
      properties: {
        passed: { type: 'boolean', example: true },
        notes: { type: 'string', example: 'Blood alcohol 0.00, vision 6/6, drug screen negative' },
        verifiedBy: { type: 'string' },
      },
    },
  })
  async submitMedical(@Param('staffId') staffId: string, @Body() details: any) {
    return this.verificationService.submitMedicalVerification(staffId, details);
  }
}
