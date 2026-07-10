import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, BadRequestException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Employee Categories')
@ApiBearerAuth()
@Controller('categories')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all employee categories' })
  async findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get details of an employee category' })
  async findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a new category (Super Admin only)' })
  async create(@Body('name') name: string) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new BadRequestException('Category name is required');
    }
    return this.service.create(name.trim());
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a category (Super Admin only)' })
  async update(@Param('id') id: string, @Body('name') name: string) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new BadRequestException('Category name is required');
    }
    return this.service.update(id, name.trim());
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a category (Super Admin only)' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
