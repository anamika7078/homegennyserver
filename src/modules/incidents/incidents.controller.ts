import { Controller, Get, Post, Param, Body, Query, Request, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { IncidentType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { IncidentsService } from './incidents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveFinanceCustomer, assertClientOwns } from '../../common/guards/client-ownership.util';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLVED', 'CLOSED'];

// Spec: Incident Trail (Pillar 9) — Client files against their own deployed
// staff, RM responds/resolves, BM handles escalations, Admin has audit
// visibility + legal-hold. No documented Staff/Finance access.
@ApiTags('Incidents')
@ApiBearerAuth()
@Controller({ path: 'incidents', version: '1' })
export class IncidentsController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(UserRole.CLIENT)
  @ApiOperation({
    summary: 'Client files an incident against their deployed staff',
    description:
      'JSON alternative to the multipart POST /client/complaints. `evidence_urls` takes plain ' +
      'string URLs and is stored; file uploads are only accepted on /client/complaints and are ' +
      'not persisted yet. Both fields are optional.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['staff_id', 'type', 'title'],
      properties: {
        staff_id: { type: 'string', description: 'Must be staff deployed to your own placement' },
        type: { type: 'string', enum: Object.values(IncidentType), example: 'CLIENT_COMPLAINT' },
        title: { type: 'string', example: 'Staff arrived 2 hours late without notice' },
        description: { type: 'string', nullable: true },
        evidence_urls: { type: 'array', items: { type: 'string' }, nullable: true },
      },
    },
  })
  async file(
    @Body() body: { staff_id: string; type: IncidentType; title: string; description?: string; evidence_urls?: string[] },
    @Request() req: AuthedRequest,
  ) {
    const client = await resolveFinanceCustomer(this.prisma, req.user.id);
    return this.incidents.fileByClient(
      { staffId: body.staff_id, type: body.type, title: body.title, description: body.description, evidenceUrls: body.evidence_urls },
      client.id,
      req.user.id,
    );
  }

  @Get()
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({
    summary: 'List incidents scoped to the caller\'s role',
    description:
      'CLIENT sees their own; RM sees the ones assigned to them; BM sees their action queue ' +
      '(ESCALATED + RESOLVED); ADMIN sees everything. Each row carries the staff member and a ' +
      'comment count. Pass ?status= to narrow to one status.',
  })
  @ApiQuery({ name: 'status', required: false, enum: INCIDENT_STATUSES })
  async list(@Request() req: AuthedRequest, @Query('status') status?: string) {
    if (status && !INCIDENT_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of: ${INCIDENT_STATUSES.join(', ')}`);
    }
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      return this.incidents.listForClient(client.id);
    }
    if (req.user.role === 'RM') return this.incidents.listForRm(req.user.id, status);
    if (req.user.role === 'BM') return this.incidents.listForBm(status);
    return this.incidents.listAll(status); // ADMIN
  }

  @Get(':id')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  async findOne(@Param('id') id: string, @Request() req: AuthedRequest) {
    const incident = await this.incidents.findOne(id);
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      assertClientOwns(client.id, incident.clientId);
    }
    return incident;
  }

  @Post(':id/comment')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'Add a comment to an incident' })
  @ApiBody({ schema: { type: 'object', required: ['body'], properties: { body: { type: 'string', example: 'Spoke to the client, visiting site tomorrow.' } } } })
  async comment(@Param('id') id: string, @Body() body: { body: string }, @Request() req: AuthedRequest) {
    if (req.user.role === 'CLIENT') {
      const [incident, client] = await Promise.all([
        this.incidents.findOne(id),
        resolveFinanceCustomer(this.prisma, req.user.id),
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
  @ApiOperation({ summary: 'RM or BM resolves the incident — a resolution note is required' })
  @ApiBody({ schema: { type: 'object', required: ['resolution'], properties: { resolution: { type: 'string', example: 'Counselled the staff member; client accepted the apology.' } } } })
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
