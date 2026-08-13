import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { SowService } from './sow.service';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveFinanceCustomer, assertClientOwns } from '../../common/guards/client-ownership.util';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

// Spec: Scope of Work (Pillar 6) — RM creates/amends/sends, Client reads/
// acknowledges own only (never modifies directly), BM approves non-standard
// SOWs, Admin has full access. Staff/Finance have no documented access.
@ApiTags('Scope of Work')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'sow', version: '1' })
export class SowController {
  constructor(
    private readonly sow: SowService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM creates a Scope of Work for a placement' })
  create(@Body() body: { placement_id: string; content: string; is_non_standard?: boolean }, @Request() req: AuthedRequest) {
    return this.sow.create({ placementId: body.placement_id, content: body.content, isNonStandard: body.is_non_standard }, req.user.id);
  }

  @Get()
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'List SOW versions for a placement' })
  async list(@Query('placement_id') placementId: string, @Request() req: AuthedRequest) {
    const rows = await this.sow.findForPlacement(placementId);
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      return rows.filter((r) => r.clientId === client.id);
    }
    return rows;
  }

  @Get(':id')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'Get a single SOW version' })
  async findOne(@Param('id') id: string, @Request() req: AuthedRequest) {
    const sow = await this.sow.findOne(id);
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      assertClientOwns(client.id, sow.clientId);
    }
    return sow;
  }

  @Patch(':id')
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Edit SOW content — only while still DRAFT' })
  update(@Param('id') id: string, @Body() body: { content: string }, @Request() req: AuthedRequest) {
    return this.sow.update(id, body.content, req.user.id);
  }

  @Post(':id/send')
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM sends the SOW to the client' })
  send(@Param('id') id: string, @Request() req: AuthedRequest) {
    return this.sow.send(id, req.user.id);
  }

  @Post(':id/acknowledge')
  @Roles(UserRole.CLIENT)
  @ApiOperation({ summary: 'Client acknowledges their own SOW' })
  async acknowledge(@Param('id') id: string, @Request() req: AuthedRequest) {
    const [sow, client] = await Promise.all([
      this.sow.findOne(id),
      resolveFinanceCustomer(this.prisma, req.user.id),
    ]);
    assertClientOwns(client.id, sow.clientId);
    return this.sow.acknowledge(id, req.user.id);
  }

  @Post(':id/amend')
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM-mediated amendment — creates a new version if the current one is already acknowledged' })
  amend(@Param('id') id: string, @Body() body: { content: string }, @Request() req: AuthedRequest) {
    return this.sow.amend(id, body.content, req.user.id);
  }

  @Post(':id/approve-non-standard')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'BM approves a non-standard SOW' })
  approveNonStandard(@Param('id') id: string, @Request() req: AuthedRequest) {
    return this.sow.approveNonStandard(id, req.user.id);
  }
}
