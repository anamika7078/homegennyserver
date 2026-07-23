import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Employees')
@ApiBearerAuth()
@Controller({ path: 'employees', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER)
  @ApiOperation({ summary: 'Get all employees (search, filters, paginate)' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  /** Lightweight employee list — all internal roles can use this for dropdowns */
  @Get('list')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get a lightweight list of active employees for dropdowns' })
  async listForDropdown(@Query('branchId') branchId?: string, @Query('status') status?: string) {
    const result = await this.service.findAll({
      branchId,
      status: status ?? 'Active',
      limit: 500,
      page: 1,
    });
    // Return slim objects suitable for dropdowns
    return result.items.map((e: any) => ({
      id: e.id,
      employeeId: e.employeeId,
      fullName: e.fullName,
      mobile: e.mobile,
      department: e.department,
      designation: e.designation,
      branchId: e.branchId,
    }));
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER)
  @ApiOperation({ summary: 'Get employee details by ID' })
  async findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Add a new employee (generates ID automatically)' })
  async create(@Body() body: any) {
    // Basic validation
    if (!body.fullName || !body.mobile || !body.dateOfBirth || !body.gender || !body.address || !body.city || !body.state || !body.pincode || !body.joiningDate || !body.branchId || !body.categoryId || !body.department || !body.designation || !body.employmentType || body.salary === undefined) {
      throw new BadRequestException('Missing required fields for employee creation');
    }
    return this.service.create(body);
  }

  @Put(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update employee information' })
  async update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Patch(':id/status')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Activate, deactivate, or resign employee' })
  async toggleStatus(@Param('id') id: string, @Body('status') status: string) {
    if (!['Active', 'Inactive', 'Resigned'].includes(status)) {
      throw new BadRequestException('Invalid status value. Must be Active, Inactive, or Resigned');
    }
    return this.service.toggleStatus(id, status);
  }

  @Post(':id/exit')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Process online or offline staff exit / resignation' })
  async processExit(
    @Param('id') id: string,
    @Body()
    body: {
      channel: 'ONLINE' | 'OFFLINE';
      reason: string;
      exitDate: string;
      notes?: string;
    },
  ) {
    if (!body?.channel || !body?.reason || !body?.exitDate) {
      throw new BadRequestException('channel, reason, and exitDate are required');
    }
    return this.service.processExit(id, body);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Soft delete employee record' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
