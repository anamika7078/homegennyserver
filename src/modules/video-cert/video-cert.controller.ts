import { Controller, Get, Post, Patch, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { VideoCertService } from './video-cert.service';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

// Spec: Video Certification (Pillar 5) — Staff records/reads their own only, RM
// reviews/signs-off, BM read-only, Admin platform-wide, Client=no access,
// Finance=no access. Confirmed live in the audit: a CLIENT token could list any
// staff's certs, and a STAFF token could read another staff member's certs (IDOR).
@ApiTags('Video Certification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'video-cert', version: '1' })
export class VideoCertController {
  constructor(private readonly service: VideoCertService) { }

  @Get('prompts/:series')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get video certification prompts for a series (MAID/SC/UC/DR)' })
  getPrompts(@Param('series') series: string) {
    return this.service.getPrompts(series);
  }

  @Post('upload-url')
  @Roles(UserRole.STAFF, UserRole.ADMIN)
  @ApiOperation({ summary: 'Generate GCS signed upload URL for video self-certification' })
  async getUploadUrl(
    @Body() body: { staffId: string; series: string; filename: string; sha256Hash?: string },
    @Request() req: AuthedRequest,
  ) {
    if (req.user.role === 'STAFF') {
      await this.service.assertStaffOwnsRecord(body.staffId, req.user.phone);
    }
    // sha256Hash is optional here — the Flutter app may compute it after recording
    return this.service.generateUploadUrl(body.staffId, body.series, body.filename, body.sha256Hash);
  }

  @Post('view-url')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Generate GCS signed playback URL (15-minute expiry) — reviewer use' })
  async getViewUrl(@Body() body: { key: string }) {
    const url = await this.service.generateViewUrl(body.key);
    return { url };
  }

  @Post('verify-hash')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Verify SHA-256 hash of stored video — confirms tamper-free integrity' })
  async verifyHash(@Body() body: { key: string; expectedHash: string }) {
    const valid = await this.service.verifyVideoHash(body.key, body.expectedHash);
    return { valid };
  }

  @Post('finalize')
  @Roles(UserRole.STAFF, UserRole.ADMIN)
  @ApiOperation({ summary: 'Finalize video upload: verify SHA-256 and persist record (Pillar 5)' })
  async finalizeUpload(
    @Body() body: { staffId: string; promptKey: string; gcsKey: string; expectedHash: string; attemptNumber?: number },
    @Request() req: AuthedRequest,
  ) {
    if (req.user.role === 'STAFF') {
      await this.service.assertStaffOwnsRecord(body.staffId, req.user.phone);
    }
    return this.service.finalizeUpload(body);
  }

  @Post('register')
  @Roles(UserRole.STAFF, UserRole.ADMIN)
  @ApiOperation({ summary: 'Register a completed video upload in DB with SHA-256 hash (Pillar 5)' })
  async registerUpload(
    @Body() body: { staffId: string; promptKey: string; gcsKey: string; sha256Hash: string; attemptNumber?: number },
    @Request() req: AuthedRequest,
  ) {
    if (req.user.role === 'STAFF') {
      await this.service.assertStaffOwnsRecord(body.staffId, req.user.phone);
    }
    return this.service.registerUpload(body);
  }

  @Get('list/:staffId')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'List all video certifications for a staff member' })
  async listForStaff(@Param('staffId') staffId: string, @Request() req: AuthedRequest) {
    if (req.user.role === 'STAFF') {
      await this.service.assertStaffOwnsRecord(staffId, req.user.phone);
    }
    return this.service.listForStaff(staffId);
  }

  @Patch('never-delete/:certId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Override never_delete flag on a video certification (Pillar 5 fraud lock)' })
  async setNeverDelete(
    @Param('certId') certId: string,
    @Body() body: { neverDelete: boolean },
  ) {
    return this.service.setNeverDeleteFlag(certId, body.neverDelete);
  }
}
