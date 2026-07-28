import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ReimbursementService } from './reimbursement.service';
import { CreateReimbursementDto, UpdateReimbursementStatusDto } from './dto/reimbursement.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Reimbursements')
@ApiBearerAuth()
@Controller({ path: 'reimbursement', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReimbursementController {
  constructor(private readonly service: ReimbursementService) {}

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'Submit expense reimbursement claim' })
  async create(@Body() dto: CreateReimbursementDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'List reimbursement claims' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'Get reimbursement claim by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Put(':id/status')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Update reimbursement status (approve/reject/paid)' })
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReimbursementStatusDto) {
    return this.service.updateStatus(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete reimbursement claim' })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(id);
  }
}
