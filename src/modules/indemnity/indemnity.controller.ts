import { BadRequestException, Controller, Get, Post, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { IndemnityService } from './indemnity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveFinanceCustomer, assertClientOwns } from '../../common/guards/client-ownership.util';

interface AuthedRequest { user: { id: string; role: string; phone: string } }

@ApiTags('Client Indemnity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'indemnity', version: '1' })
export class IndemnityController {
  constructor(
    private readonly indemnity: IndemnityService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(UserRole.RM, UserRole.ADMIN)
  @ApiOperation({ summary: 'RM sends an indemnity clause to a client' })
  send(@Body() body: { placement_id: string; clause_version: string; clause_text: string }, @Request() req: AuthedRequest) {
    // Same fix as SowController.create — an omitted placement_id previously fell through
    // to prisma.placement.findUnique({ where: { id: undefined } }) and 500'd instead of
    // a clean 400 (confirmed live during the S4/S5 flow audit).
    if (!body.placement_id) throw new BadRequestException('placement_id is required');
    if (!body.clause_version) throw new BadRequestException('clause_version is required');
    if (!body.clause_text) throw new BadRequestException('clause_text is required');
    return this.indemnity.send({ placementId: body.placement_id, clauseVersion: body.clause_version, clauseText: body.clause_text }, req.user.id);
  }

  @Get()
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  @ApiOperation({ summary: 'List indemnity clauses sent for a placement' })
  async list(@Query('placement_id') placementId: string, @Request() req: AuthedRequest) {
    const rows = await this.indemnity.findForPlacement(placementId);
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      return rows.filter((r) => r.clientId === client.id);
    }
    return rows;
  }

  @Get(':id')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.CLIENT)
  async findOne(@Param('id') id: string, @Request() req: AuthedRequest) {
    const row = await this.indemnity.findOne(id);
    if (req.user.role === 'CLIENT') {
      const client = await resolveFinanceCustomer(this.prisma, req.user.id);
      assertClientOwns(client.id, row.clientId);
    }
    return row;
  }

  @Post(':id/acknowledge')
  @Roles(UserRole.CLIENT)
  @ApiOperation({ summary: 'Client acknowledges their own indemnity clause' })
  async acknowledge(@Param('id') id: string, @Request() req: AuthedRequest) {
    const [row, client] = await Promise.all([
      this.indemnity.findOne(id),
      resolveFinanceCustomer(this.prisma, req.user.id),
    ]);
    assertClientOwns(client.id, row.clientId);
    return this.indemnity.acknowledge(id, req.user.id);
  }

  @Post(':id/contest')
  @Roles(UserRole.CLIENT)
  @ApiOperation({ summary: 'Client contests an indemnity clause instead of acknowledging it' })
  async contest(@Param('id') id: string, @Body() body: { reason?: string }, @Request() req: AuthedRequest) {
    const [row, client] = await Promise.all([
      this.indemnity.findOne(id),
      resolveFinanceCustomer(this.prisma, req.user.id),
    ]);
    assertClientOwns(client.id, row.clientId);
    return this.indemnity.contest(id, req.user.id, body.reason);
  }

  @Post(':id/bm-review')
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'BM reviews a contested indemnity clause' })
  bmReview(@Param('id') id: string, @Body() body: { notes: string }, @Request() req: AuthedRequest) {
    return this.indemnity.bmReview(id, req.user.id, body.notes);
  }
}
