import { Controller, Get, Post, Body, Param, UseGuards, Req } from '@nestjs/common';
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

  @Post()
  @Roles(UserRole.ADMIN, UserRole.BM)
  @ApiOperation({ summary: 'Generate a new agreement' })
  async create(@Body() body: any) {
    return this.agreementsService.createAgreement(body);
  }

  @Post('esign/send-otp')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Send e-sign OTP for A1–A5 (logged server-side; wire SMS in prod)' })
  async sendEsignOtp(@Body() dto: SendEsignOtpDto) {
    return this.agreementsService.sendEsignOtp(dto);
  }

  @Get('client/:clientId')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Get agreements for a client' })
  async findByClient(@Param('clientId') clientId: string) {
    return this.agreementsService.findByClient(clientId);
  }

  @Post(':id/sign')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Sign an agreement' })
  async sign(@Param('id') id: string, @Req() req: any) {
    return this.agreementsService.signAgreement(id, {
      userId: req.user.id,
      role: req.user.role,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? '',
    });
  }
}
