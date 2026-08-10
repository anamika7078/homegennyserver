import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { FinanceCustomerService, CreateCustomerDto } from './customer.service';

// Finance-console customer master (billing entities), admin-panel only.
// Not the same path a self-registering Customer touches (that goes through
// AuthService directly). RM/BM/Finance/Admin per Client Invoicing matrix row.
@ApiTags('Finance — Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/customers', version: '1' })
export class FinanceCustomerController {
  constructor(private readonly service: FinanceCustomerService) {}

  @Get()
  @ApiOperation({ summary: 'List all finance customers with branches' })
  @ApiQuery({ name: 'search', required: false })
  listCustomers(@Query('search') search?: string) {
    return this.service.listCustomers(search);
  }

  @Get('branches/all')
  @ApiOperation({ summary: 'List all customer branches' })
  listAllCustomerBranches() {
    return this.service.listAllCustomerBranches();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new finance customer with multi-branch support' })
  createCustomer(@Body() body: CreateCustomerDto) {
    return this.service.createCustomer(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single finance customer by ID' })
  getCustomer(@Param('id') id: string) {
    return this.service.getCustomer(id);
  }

  @Get(':id/branches')
  @ApiOperation({ summary: 'Get all active branches for a customer' })
  getCustomerBranches(@Param('id') id: string) {
    return this.service.getCustomerBranches(id);
  }

  @Post(':id/branches')
  @ApiOperation({ summary: 'Add a new branch to an existing customer' })
  addCustomerBranch(@Param('id') id: string, @Body() body: any) {
    return this.service.addCustomerBranch(id, body);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a finance customer' })
  updateCustomer(@Param('id') id: string, @Body() body: Partial<CreateCustomerDto> & { status?: string }) {
    return this.service.updateCustomer(id, body);
  }

  @Post(':id/bill-number')
  @ApiOperation({ summary: 'Generate next bill number for a customer (month-wise counter)' })
  generateBillNumber(@Param('id') id: string) {
    return this.service.generateBillNumber(id).then((bill_number) => ({ bill_number }));
  }
}
