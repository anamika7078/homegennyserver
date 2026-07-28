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
import { LoanService } from './loan.service';
import { CreateEmployeeLoanDto, CreateSalaryAdvanceDto, UpdateLoanStatusDto } from './dto/loan.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Loans and Salary Advances')
@ApiBearerAuth()
@Controller({ path: 'loan', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class LoanController {
  constructor(private readonly service: LoanService) {}

  // Employee Loans Endpoints
  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create employee loan record' })
  async createLoan(@Body() dto: CreateEmployeeLoanDto) {
    return this.service.createLoan(dto);
  }

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List employee loans' })
  async findAllLoans(@Query() query: any) {
    return this.service.findAllLoans(query);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get employee loan details by ID' })
  async findLoanById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findLoanById(id);
  }

  @Put(':id/status')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update employee loan status (active/closed/defaulted)' })
  async updateLoanStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLoanStatusDto) {
    return this.service.updateLoanStatus(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete employee loan' })
  async deleteLoan(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteLoan(id);
  }

  // Salary Advances Endpoints
  @Post('advance')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Grant short-term salary advance' })
  async createAdvance(@Body() dto: CreateSalaryAdvanceDto) {
    return this.service.createAdvance(dto);
  }

  @Get('advance/list')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List short-term salary advances' })
  async findAllAdvances(@Query() query: any) {
    return this.service.findAllAdvances(query);
  }

  @Put('advance/:id/status')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update salary advance status' })
  async updateAdvanceStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLoanStatusDto) {
    return this.service.updateAdvanceStatus(id, dto);
  }

  @Delete('advance/:id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete salary advance' })
  async deleteAdvance(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteAdvance(id);
  }
}
