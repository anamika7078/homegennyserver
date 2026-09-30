import {
  Controller, Get, Post, Delete, Param, Body, Query, Req, Res,
  UseInterceptors, UploadedFile, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingMaterialsService } from './training-materials.service';
import { resolveStaffApplicantId } from './staff-identity.util';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

@ApiTags('Training')
@ApiBearerAuth()
@Controller({ path: 'training/materials', version: '1' })
export class TrainingMaterialsController {
  constructor(
    private readonly service: TrainingMaterialsService,
    private readonly prisma: PrismaService,
  ) {}

  /** STAFF may only read material of batches they're enrolled in; every other allowed role reads freely. */
  private async assertStaffBatch(req: AuthedRequest, batchId: string) {
    if (req.user.role !== UserRole.STAFF) return;
    const staffId = await resolveStaffApplicantId(this.prisma, req.user.id, req.user.phone);
    if (!(await this.service.isStaffEnrolled(staffId, batchId))) {
      throw new ForbiddenException('Not enrolled in this batch');
    }
  }

  private async assertStaffFile(req: AuthedRequest, key: string) {
    if (req.user.role !== UserRole.STAFF) return;
    const staffId = await resolveStaffApplicantId(this.prisma, req.user.id, req.user.phone);
    await this.service.assertStaffCanReadFile(staffId, key);
  }

  @Get()
  @Roles(UserRole.TRAINER, UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'List study material for a batch (STAFF: only batches they are enrolled in)' })
  async list(@Query('batch_id') batchId: string, @Req() req: AuthedRequest) {
    if (!batchId) throw new BadRequestException('batch_id is required');
    await this.assertStaffBatch(req, batchId);
    return this.service.list(batchId);
  }

  @Post('video/upload-url')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get an upload target for a study-material video (GCS signed URL, or the local-upload route)' })
  @ApiBody({ schema: { type: 'object', required: ['batch_id', 'filename'], properties: {
    batch_id: { type: 'string' }, filename: { type: 'string', example: 'day1-intro.mp4' },
  } } })
  getVideoUploadUrl(@Body() body: { batch_id: string; filename: string }) {
    return this.service.generateVideoUploadUrl(body.batch_id, body.filename);
  }

  @Post('local-upload')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '⚠️ Local storage mode only — receives the raw video for a key issued by video/upload-url' })
  localUpload(@Body('key') key: string, @Body('batch_id') batchId: string, @UploadedFile() file: Express.Multer.File) {
    if (!key) throw new BadRequestException('key is required');
    if (!file) throw new BadRequestException('file is required');
    return this.service.saveLocalVideoUpload(key, file.buffer, batchId);
  }

  @Get('local-file')
  @Roles(UserRole.TRAINER, UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: '⚠️ Local storage mode only — streams back a locally-stored study material video' })
  async localFile(@Query('key') key: string, @Req() req: AuthedRequest, @Res() res: Response) {
    if (!key) throw new BadRequestException('key is required');
    await this.assertStaffFile(req, key);
    const stream = this.service.readLocalVideoFile(key);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);
  }

  @Post('pdf')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a PDF study material in one step (small file — no signed-URL dance needed)' })
  @ApiBody({ schema: { type: 'object', required: ['batch_id', 'title', 'file'], properties: {
    batch_id: { type: 'string' }, title: { type: 'string' }, file: { type: 'string', format: 'binary' },
  } } })
  async uploadPdf(
    @Body('batch_id') batchId: string,
    @Body('title') title: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthedRequest,
  ) {
    if (!batchId) throw new BadRequestException('batch_id is required');
    if (!title) throw new BadRequestException('title is required');
    if (!file) throw new BadRequestException('file is required');
    if (file.mimetype !== 'application/pdf') throw new BadRequestException('Only PDF files are accepted here');
    const { key: pdfKey } = await this.service.savePdf(batchId, file);
    return this.service.create({
      batchId, type: 'PDF', title, storageKey: pdfKey, sizeBytes: file.size, uploadedBy: req.user.id,
    });
  }

  @Get('pdf-file')
  @Roles(UserRole.TRAINER, UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.STAFF)
  @ApiOperation({ summary: 'Download/view a PDF study material' })
  async pdfFile(@Query('key') key: string, @Req() req: AuthedRequest, @Res() res: Response) {
    if (!key) throw new BadRequestException('key is required');
    await this.assertStaffFile(req, key);
    const stream = await this.service.readPdf(key);
    res.setHeader('Content-Type', 'application/pdf');
    stream.pipe(res);
  }

  @Post()
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Attach study material to a batch (VIDEO — after the upload steps above — or NOTE)' })
  @ApiBody({ schema: { type: 'object', required: ['batch_id', 'type', 'title'], properties: {
    batch_id: { type: 'string' },
    type: { type: 'string', enum: ['VIDEO', 'NOTE'] },
    title: { type: 'string' },
    storage_key: { type: 'string', description: 'Required for VIDEO — the key from video/upload-url' },
    body: { type: 'string', description: 'Required for NOTE — the plain-text content' },
  } } })
  create(
    @Body() body: { batch_id: string; type: 'VIDEO' | 'NOTE'; title: string; storage_key?: string; body?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.service.create({
      batchId: body.batch_id, type: body.type, title: body.title,
      storageKey: body.storage_key, body: body.body, uploadedBy: req.user.id,
    });
  }

  @Delete(':id')
  @Roles(UserRole.TRAINER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Remove a study material item' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
