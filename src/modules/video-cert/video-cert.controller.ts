import { Controller, Get, Post, Patch, Param, Body, UseGuards, UseInterceptors, UploadedFile, Query, Res, Request, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { VideoCertService } from './video-cert.service';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

// Spec: Video Certification (Pillar 5) — Staff records/reads their own only, RM
// reviews/signs-off, BM read-only, Admin platform-wide, Client=no access,
// Finance=no access. Confirmed live in the audit: a CLIENT token could list any
// staff's certs, and a STAFF token could read another staff member's certs (IDOR).
//
// ⚠️ KNOWN GAP: the actual approve/reject action is PUT /trainer/video-certifications/:id/review
// (trainer.controller.ts), which is TRAINER/ADMIN-only today — RM is NOT permitted to approve/reject
// despite the spec above saying "RM reviews/signs-off". Not fixed in this pass — flagging for later.
@ApiTags('Video Certification', 'Mobile App RM APIs')
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
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staffId', 'series', 'filename'],
      properties: {
        staffId: { type: 'string', example: 'b0116bc6-b2db-45e3-a6af-530b285a777e' },
        series: { type: 'string', enum: ['DR', 'SC', 'UC', 'MAID'], example: 'MAID' },
        filename: { type: 'string', example: 'prompt2.mp4' },
        sha256Hash: { type: 'string', description: 'Optional — app may compute this after recording, before finalize' },
      },
    },
  })
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
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.TRAINER)
  @ApiOperation({ summary: 'Generate GCS signed playback URL (15-minute expiry) — reviewer use' })
  @ApiBody({ schema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'GCS object key from the finalize/register response' } } } })
  async getViewUrl(@Body() body: { key: string }) {
    // Was RM/BM/Admin only — Trainer is who actually reviews these and needs
    // to watch the video first, added alongside the local-storage jugaad.
    const url = await this.service.generateViewUrl(body.key);
    return { url };
  }

  @Post('local-upload')
  @Roles(UserRole.STAFF, UserRole.ADMIN)
  // Without an explicit `storage`, multer defaults to disk storage — `file.buffer`
  // (which saveLocalUpload below relies on) would be undefined and `fs.writeFileSync`
  // would throw. memoryStorage() is what actually populates `.buffer`.
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '⚠️ TEMPORARY (local storage mode only): receives the raw video file for a key ' +
      'issued by upload-url, in place of POSTing directly to GCS. Only active while ' +
      'VIDEO_STORAGE_MODE=local — disabled (400) once a real GCS bucket is configured.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['key', 'file'],
      properties: {
        key: { type: 'string', description: 'gcsKey returned by upload-url' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  localUpload(@Body('key') key: string, @UploadedFile() file: Express.Multer.File, @Request() req: AuthedRequest) {
    if (!key) throw new BadRequestException('key is required');
    if (!file) throw new BadRequestException('file is required');
    return this.service.saveLocalUpload(key, file.buffer);
  }

  @Get('local-file')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.TRAINER, UserRole.STAFF)
  @ApiOperation({ summary: '⚠️ TEMPORARY (local storage mode only): streams back a locally-stored video for playback.' })
  async localFile(@Query('key') key: string, @Request() req: AuthedRequest, @Res() res: Response) {
    if (!key) throw new BadRequestException('key is required');
    if (req.user.role === 'STAFF') {
      // videoUrl keys embed the owning staffId as their 3rd path segment —
      // video-certs/<series>/<staffId>/<file> — cheap enough to check without
      // a DB round trip, same ownership intent as assertStaffOwnsRecord elsewhere.
      const staffIdInKey = key.split('/')[2];
      await this.service.assertStaffOwnsRecord(staffIdInKey, req.user.phone);
    }
    const stream = this.service.readLocalFile(key);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);
  }

  @Post('verify-hash')
  @Roles(UserRole.STAFF, UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Verify SHA-256 hash of stored video — confirms tamper-free integrity' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['key', 'expectedHash'],
      properties: {
        key: { type: 'string', description: 'GCS object key' },
        expectedHash: { type: 'string', example: 'a3f8c92d4b1e7f6a...' },
      },
    },
  })
  async verifyHash(@Body() body: { key: string; expectedHash: string }) {
    const valid = await this.service.verifyVideoHash(body.key, body.expectedHash);
    return { valid };
  }

  @Post('finalize')
  @Roles(UserRole.STAFF, UserRole.ADMIN)
  @ApiOperation({ summary: 'Finalize video upload: verify SHA-256 and persist record (Pillar 5)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staffId', 'promptKey', 'gcsKey', 'expectedHash'],
      properties: {
        staffId: { type: 'string' },
        promptKey: { type: 'string', example: 'prompt_2' },
        gcsKey: { type: 'string', description: 'Object key returned by upload-url' },
        expectedHash: { type: 'string' },
        attemptNumber: { type: 'number', example: 1 },
      },
    },
  })
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
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staffId', 'promptKey', 'gcsKey', 'sha256Hash'],
      properties: {
        staffId: { type: 'string' },
        promptKey: { type: 'string', example: 'prompt_2' },
        gcsKey: { type: 'string' },
        sha256Hash: { type: 'string' },
        attemptNumber: { type: 'number', example: 1 },
      },
    },
  })
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
  @ApiBody({ schema: { type: 'object', required: ['neverDelete'], properties: { neverDelete: { type: 'boolean' } } } })
  async setNeverDelete(
    @Param('certId') certId: string,
    @Body() body: { neverDelete: boolean },
  ) {
    return this.service.setNeverDeleteFlag(certId, body.neverDelete);
  }
}
