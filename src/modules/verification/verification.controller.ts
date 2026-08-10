import { Controller, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { VerificationService } from './verification.service';

// Spec: DL/Aadhaar Verify (Pillar 1) and PV/Medical (Pillars 3/4) — RM=Y, Admin=Y,
// Staff/Client/Finance=no access. Confirmed live in the audit: POST /verification/dl
// returned 201 for STAFF, CLIENT and FINANCE tokens before this fix.
@ApiTags('Verification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.ADMIN)
@Controller({ path: 'verification', version: '1' })
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('dl')
  @ApiOperation({ summary: 'Verify driving licence via Sarathi API' })
  async verifyDL(@Body() body: { dl_number: string; dob: string; staff_id?: string }) {
    return this.verificationService.verifyDrivingLicence(body.dl_number, body.dob, body.staff_id);
  }

  @Post('echallan/:dlNumber')
  @ApiOperation({ summary: 'Check eChallan violations for a DL' })
  async checkEchallan(@Param('dlNumber') dlNumber: string, @Query('staff_id') staffId?: string) {
    return this.verificationService.checkEchallan(dlNumber, staffId);
  }

  @Post('aadhaar')
  @ApiOperation({ summary: 'Verify Aadhaar via UIDAI API' })
  async verifyAadhaar(@Body() body: { aadhaar_number: string; otp: string }) {
    return this.verificationService.verifyAadhaar(body.aadhaar_number, body.otp);
  }

  @Post('pv/submit/:staffId')
  @ApiOperation({ summary: 'Submit police verification request' })
  async submitPV(@Param('staffId') staffId: string, @Body() details: any) {
    return this.verificationService.submitPoliceVerification(staffId, details);
  }

  @Post('medical/submit/:staffId')
  @ApiOperation({ summary: 'Submit medical/sobriety test results' })
  async submitMedical(@Param('staffId') staffId: string, @Body() details: any) {
    return this.verificationService.submitMedicalVerification(staffId, details);
  }
}
