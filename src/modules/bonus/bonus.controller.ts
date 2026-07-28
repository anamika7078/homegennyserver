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
import { BonusService } from './bonus.service';
import { CreateBonusRecordDto, UpdateBonusRecordDto } from './dto/bonus.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Bonus')
@ApiBearerAuth()
@Controller({ path: 'bonus', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class BonusController {
  constructor(private readonly service: BonusService) {}

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create bonus grant for employee' })
  async create(@Body() dto: CreateBonusRecordDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List bonus records with filtering' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get bonus record by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Put(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update bonus record' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBonusRecordDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete bonus record' })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(id);
  }
}
