import {
  Controller, Get, Post, Put, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FinanceCustomerService, CreateCustomerDto } from './customer.service';

@ApiTags('Finance — Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'finance/customers', version: '1' })
export class FinanceCustomerController {
  constructor(private readonly service: FinanceCustomerService) {}

  @Get()
  @ApiOperation({ summary: 'List all finance customers' })
  @ApiQuery({ name: 'search', required: false })
  listCustomers(@Query('search') search?: string) {
    return this.service.listCustomers(search);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new finance customer (auto-generates unit code)' })
  createCustomer(@Body() body: CreateCustomerDto) {
    return this.service.createCustomer(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single finance customer by ID' })
  getCustomer(@Param('id') id: string) {
    return this.service.getCustomer(id);
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
