import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { AgreementsService } from './agreements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SendEsignOtpDto } from './dto/send-esign-otp.dto';

@ApiTags('Agreements')
@ApiBearerAuth()
@Controller({ path: 'agreements', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgreementsController {
  constructor(private readonly agreementsService: AgreementsService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'List agreements' })
  list(
    @Query('staffId') staffId?: string,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
  ) {
    return this.agreementsService.list({ staffId, clientId, status });
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.BM)
  create(@Body() body: Record<string, unknown>) {
    return this.agreementsService.createAgreement({
      staff_id: body.staff_id as string,
      client_id: String(body.client_id),
      type: String(body.type),
      placement_id: body.placement_id as string,
    });
  }

  @Post('esign/send-otp')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  sendEsignOtp(@Body() dto: SendEsignOtpDto) {
    return this.agreementsService.sendEsignOtp(dto);
  }

  @Post('esign/verify-otp')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  verifyOtp(@Body() body: { staff_id: string; agreement_type: string; otp: string }) {
    return this.agreementsService.verifyEsignOtp(body.staff_id, body.agreement_type, body.otp);
  }

  @Post(':id/generate-pdf')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  generatePdf(@Param('id') id: string) {
    return this.agreementsService.generatePdf(id);
  }

  @Post('video-cert/:staffId/lock')
  @Roles(UserRole.TRAINER, UserRole.BM, UserRole.ADMIN)
  lockVideoCert(
    @Param('staffId') staffId: string,
    @Body() body: { video_cert_id: string },
    @Req() req: { user: { id: string } },
  ) {
    return this.agreementsService.lockVideoCert(staffId, body.video_cert_id, req.user.id);
  }

  @Get('client/:clientId')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  findByClient(@Param('clientId') clientId: string) {
    return this.agreementsService.findByClient(clientId);
  }

  @Post(':id/sign')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  sign(@Param('id') id: string, @Body() body: { otp?: string }, @Req() req: any) {
    return this.agreementsService.signAgreement(id, {
      userId: req.user.id,
      role: req.user.role,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? '',
      otp: body.otp,
    });
  }
}
