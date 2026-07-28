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
import { OvertimeService } from './overtime.service';
import { CreateOvertimeRuleDto, UpdateOvertimeRuleDto, CreateOvertimeRecordDto } from './dto/overtime.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Overtime')
@ApiBearerAuth()
@Controller({ path: 'overtime', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class OvertimeController {
  constructor(private readonly service: OvertimeService) {}

  // Rules Endpoints
  @Post('rules')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create overtime calculation rule' })
  async createRule(@Body() dto: CreateOvertimeRuleDto) {
    return this.service.createRule(dto);
  }

  @Get('rules')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List all overtime calculation rules' })
  async findAllRules() {
    return this.service.findAllRules();
  }

  @Put('rules/:id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update overtime rule' })
  async updateRule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOvertimeRuleDto) {
    return this.service.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete overtime rule' })
  async deleteRule(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteRule(id);
  }

  // Records Endpoints
  @Post('records')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'Log overtime record for an employee' })
  async createRecord(@Body() dto: CreateOvertimeRecordDto) {
    return this.service.createRecord(dto);
  }

  @Get('records')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'List overtime records with filtering' })
  async findAllRecords(@Query() query: any) {
    return this.service.findAllRecords(query);
  }

  @Put('records/:id/approve')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Approve overtime record' })
  async approveRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('role') role?: 'manager' | 'hr' | 'payroll',
  ) {
    return this.service.approveRecord(id, role);
  }

  @Put('records/:id/reject')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Reject overtime record' })
  async rejectRecord(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.rejectRecord(id);
  }

  @Delete('records/:id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete overtime record' })
  async deleteRecord(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteRecord(id);
  }
}
