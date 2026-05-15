import { Controller, Get, Post, Body, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Clients')
@ApiBearerAuth()
@Controller({ path: 'clients', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Post()
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Register a new client' })
  async create(@Body() body: any) {
    return this.clientsService.create(body);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Get all clients' })
  async findAll(@Query() query: any) {
    return this.clientsService.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Get client details' })
  async findOne(@Param('id') id: string) {
    return this.clientsService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.BM)
  @ApiOperation({ summary: 'Update client info' })
  async update(@Param('id') id: string, @Body() body: any) {
    return this.clientsService.update(id, body);
  }
}
