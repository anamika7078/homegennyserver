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
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all employees (search, filters, paginate)' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
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

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Soft delete employee record' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
