import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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

  @Post('metadata')
  @ApiOperation({ summary: 'Get GCS object metadata including retention expiry' })
  async getMetadata(@Body() body: { key: string }) {
    return this.service.getObjectMetadata(body.key);
  }
}
