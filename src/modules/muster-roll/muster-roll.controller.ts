import { Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { sendStoredFile } from '../../common/storage/send-file.util';
import { MusterRollService } from './muster-roll.service';

type Req = { user: { id: string; role: string } };

/** The Form XVI muster roll for RM, HR and Finance. */
@ApiTags('Muster roll')
@ApiBearerAuth()
@Roles(UserRole.RM, UserRole.BM, UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'muster-rolls', version: '1' })
export class MusterRollController {
  constructor(private readonly svc: MusterRollService) {}

  @Get()
  @ApiOperation({
    summary: 'A client\'s muster roll for a month: the live roll, its signed versions, and what changed since signing',
    description:
      'rows[] (code, rank, name, father_or_husband_name, sex, days[1..n]: P | A | ½ | L | WO | "", days_present, ' +
      'additional_hours, weekly_off, total, remarks), daily_mandays, totals, proof (staff-app days by client status), ' +
      'signed (current version or null), changed_since_signed[], versions[].',
  })
  @ApiQuery({ name: 'client_id' }) @ApiQuery({ name: 'month' }) @ApiQuery({ name: 'year' })
  view(@Query('client_id') clientId: string, @Query('month') month: string, @Query('year') year: string) {
    return this.svc.view(clientId, month, year);
  }

  // Literal paths before ':id/…'.
  @Get('clients')
  @ApiOperation({ summary: 'Clients with staff placed — to pick whose muster roll to open (name, unit code; ?search=)' })
  @ApiQuery({ name: 'search', required: false })
  clients(@Query('search') search?: string) {
    return this.svc.clients(search);
  }

  @Get('print')
  @ApiOperation({ summary: 'Printable Form XVI (HTML, A4 landscape). version= prints a signed version; audit=1 adds the proof page' })
  @ApiQuery({ name: 'client_id' }) @ApiQuery({ name: 'month' }) @ApiQuery({ name: 'year' })
  @ApiQuery({ name: 'version', required: false }) @ApiQuery({ name: 'audit', required: false })
  async print(@Query() q: { client_id: string; month: string; year: string; version?: string; audit?: string }, @Res() res: Response) {
    const html = await this.svc.html(q.client_id, q.month, q.year, { version: q.version ? Number(q.version) : undefined, audit: q.audit === '1' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  @Post('upload')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @UseInterceptors(AnyFilesInterceptor({ storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload the paper muster roll the client signed',
    description:
      'multipart: file (JPG/PNG/WEBP/PDF ≤ 10 MB), client_id, month, year, signed_name?, note?. Stores the roll as signed ' +
      '(new version) and confirms the month\'s staff-app days still waiting on the client (APPROVED_PAPER).',
  })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, client_id: { type: 'string' }, month: { type: 'integer' }, year: { type: 'integer' }, signed_name: { type: 'string' }, note: { type: 'string' } } } })
  upload(@Req() req: Req, @UploadedFiles() files: { buffer: Buffer; mimetype: string; originalname?: string; size: number }[] = [], @Body() body: Record<string, string>) {
    return this.svc.uploadPaper(req.user, body, files[0]);
  }

  @Get(':id/scan')
  @ApiOperation({ summary: 'The uploaded signed paper roll' })
  async scan(@Req() req: Req, @Param('id') id: string, @Res() res: Response) {
    const f = await this.svc.scan(id, req.user);
    sendStoredFile(res, f.stream, f.mime, 'inline', f.name);
  }
}

/** The client's side: see, print and sign their own month. */
@ApiTags('Client Mobile App', 'Mobile App Client APIs')
@ApiBearerAuth()
@Roles(UserRole.CLIENT)
@Controller({ path: 'client/muster-rolls', version: '1' })
export class ClientMusterRollController {
  constructor(private readonly svc: MusterRollService) {}

  @Get()
  @ApiOperation({ summary: 'My muster roll for a month (same shape as GET /muster-rolls), with whether I have signed it' })
  @ApiQuery({ name: 'month' }) @ApiQuery({ name: 'year' })
  view(@Req() req: Req, @Query('month') month: string, @Query('year') year: string) {
    return this.svc.viewForClient(req.user, month, year);
  }

  @Get('print')
  @ApiOperation({ summary: 'My muster roll as a printable Form XVI (HTML)' })
  @ApiQuery({ name: 'month' }) @ApiQuery({ name: 'year' })
  async print(@Req() req: Req, @Query('month') month: string, @Query('year') year: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(await this.svc.htmlForClient(req.user, month, year));
  }

  @Post('sign')
  @ApiOperation({
    summary: 'Sign the month\'s muster roll in the app',
    description: 'Body { month, year, name }. Stores it as signed (new version) and confirms the month\'s staff-app days still waiting on me.',
  })
  sign(@Req() req: Req, @Body() body: { month?: number; year?: number; name?: string }) {
    return this.svc.signByClient(req.user, body ?? {});
  }
}
