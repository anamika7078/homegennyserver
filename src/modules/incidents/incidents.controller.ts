import { Controller, Get, Post, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IncidentType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { IncidentsService } from './incidents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveClientProfile, assertClientOwns } from '../../common/guards/client-ownership.util';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

// Spec: Incident Trail (Pillar 9) — Client files against their own deployed
// staff, RM responds/resolves, BM handles escalations, Admin has audit
// visibility + legal-hold. No documented Staff/Finance access.
@ApiTags('Incidents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'incidents', version: '1' })
export class IncidentsController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(UserRole.CLIENT)
  @ApiOperation({ summary: 'Client files an incident against their deployed staff' })
  async file(
    @Body() body: { staff_id: string; type: IncidentType; title: string; description?: string; evidence_urls?: string[] },
    @Request() req: AuthedRequest,
  ) {
    const client = await resolveClientProfile(this.prisma, req.user.phone);
    return this.incidents.fileByClient(
      { staffId: body.staff_id, type: body.type, title: body.title, description: body.description, evidenceUrls: body.evidence_urls },
      client.id,
      req.user.id,
    );
  }

  @Get()
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'List incidents scoped to the caller\'s role' })
  async list(@Request() req: AuthedRequest) {
    if (req.user.role === 'CLIENT') {
      const client = await resolveClientProfile(this.prisma, req.user.phone);
      return this.incidents.listForClient(client.id);
    }
    if (req.user.role === 'RM') return this.incidents.listForRm(req.user.id);
    if (req.user.role === 'BM') return this.incidents.listEscalated();
    return this.incidents.listAll(); // ADMIN
  }

  @Get(':id')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  async findOne(@Param('id') id: string, @Request() req: AuthedRequest) {
    const incident = await this.incidents.findOne(id);
    if (req.user.role === 'CLIENT') {
      const client = await resolveClientProfile(this.prisma, req.user.phone);
      assertClientOwns(client.id, incident.clientId);
    }
    return incident;
  }

  @Post(':id/comment')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'Add a comment to an incident' })
  async comment(@Param('id') id: string, @Body() body: { body: string }, @Request() req: AuthedRequest) {
    if (req.user.role === 'CLIENT') {
      const [incident, client] = await Promise.all([
        this.incidents.findOne(id),
        resolveClientProfile(this.prisma, req.user.phone),
      ]);
      assertClientOwns(client.id, incident.clientId);
    }
    return this.incidents.addComment(id, req.user.id, body.body);
  }

  @Post(':id/acknowledge')
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM acknowledges and begins investigating' })
  acknowledge(@Param('id') id: string, @Request() req: AuthedRequest) {
    return this.incidents.acknowledge(id, req.user.id);
  }

  @Post(':id/resolve')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM or BM resolves the incident' })
  resolve(@Param('id') id: string, @Body() body: { resolution: string }, @Request() req: AuthedRequest) {
    return this.incidents.resolve(id, req.user.id, body.resolution);
  }

  @Post(':id/escalate')
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM escalates to BM' })
  escalate(@Param('id') id: string, @Request() req: AuthedRequest) {
    return this.incidents.escalate(id, req.user.id);
  }

  @Post(':id/close')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'BM closes a resolved incident' })
  close(@Param('id') id: string, @Request() req: AuthedRequest) {
    return this.incidents.close(id, req.user.id);
  }

  @Post(':id/legal-hold')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin sets/clears the legal-hold flag' })
  legalHold(@Param('id') id: string, @Body() body: { hold: boolean }, @Request() req: AuthedRequest) {
    return this.incidents.setLegalHold(id, req.user.id, body.hold);
  }
}
