import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { VideoCertService } from './video-cert.service';

@ApiTags('Video Certification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'video-cert', version: '1' })
export class VideoCertController {
  constructor(private readonly service: VideoCertService) { }

  @Get('prompts/:series')
  @ApiOperation({ summary: 'Get video certification prompts for a series (MAID/SC/UC/DR)' })
  getPrompts(@Param('series') series: string) {
    return this.service.getPrompts(series);
  }

  @Post('upload-url')
  @ApiOperation({ summary: 'Generate GCS signed upload URL for video self-certification' })
  async getUploadUrl(
    @Body() body: { staffId: string; series: string; filename: string; sha256Hash?: string },
  ) {
    // sha256Hash is optional here — the Flutter app may compute it after recording
    return this.service.generateUploadUrl(body.staffId, body.series, body.filename, body.sha256Hash);
  }

  @Post('view-url')
  @ApiOperation({ summary: 'Generate GCS signed playback URL (15-minute expiry)' })
  async getViewUrl(@Body() body: { key: string }) {
    const url = await this.service.generateViewUrl(body.key);
    return { url };
  }

  @Post('verify-hash')
  @ApiOperation({ summary: 'Verify SHA-256 hash of stored video — confirms tamper-free integrity' })
  async verifyHash(@Body() body: { key: string; expectedHash: string }) {
    const valid = await this.service.verifyVideoHash(body.key, body.expectedHash);
    return { valid };
  }

  @Post('finalize')
  @ApiOperation({ summary: 'Finalize video upload: verify SHA-256 and persist record (Pillar 5)' })
  async finalizeUpload(@Body() body: { staffId: string; promptKey: string; gcsKey: string; expectedHash: string; attemptNumber?: number }) {
    return this.service.finalizeUpload(body);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a completed video upload in DB with SHA-256 hash (Pillar 5)' })
  async registerUpload(
    @Body() body: { staffId: string; promptKey: string; gcsKey: string; sha256Hash: string; attemptNumber?: number },
  ) {
    return this.service.registerUpload(body);
  }

  @Get('list/:staffId')
  @ApiOperation({ summary: 'List all video certifications for a staff member' })
  async listForStaff(@Param('staffId') staffId: string) {
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
