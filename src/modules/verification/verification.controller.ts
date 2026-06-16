import { Controller, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VerificationService } from './verification.service';

@ApiTags('Verification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'verification', version: '1' })
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('dl')
  @ApiOperation({ summary: 'Verify driving licence via Sarathi API' })
  async verifyDL(@Body() body: { dl_number: string; dob: string }) {
    return this.verificationService.verifyDrivingLicence(body.dl_number, body.dob);
  }

  @Post('echallan/:dlNumber')
  @ApiOperation({ summary: 'Check eChallan violations for a DL' })
  async checkEchallan(@Param('dlNumber') dlNumber: string) {
    return this.verificationService.checkEchallan(dlNumber);
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
