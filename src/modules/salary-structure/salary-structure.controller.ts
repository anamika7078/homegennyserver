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
import { SalaryStructureService } from './salary-structure.service';
import { CreateSalaryStructureDto, UpdateSalaryStructureDto } from './dto/salary-structure.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Salary Structure')
@ApiBearerAuth()
@Controller({ path: 'salary-structure', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalaryStructureController {
  constructor(private readonly service: SalaryStructureService) {}

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create a new salary structure template with components' })
  async create(@Body() dto: CreateSalaryStructureDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List salary structure templates with search and pagination' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get salary structure template details by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Put(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Update a salary structure template and its components' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSalaryStructureDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Delete a salary structure template' })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(id);
  }

  @Post(':id/clone')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Clone/duplicate an existing salary structure template' })
  async clone(@Param('id', ParseUUIDPipe) id: string, @Body('newTemplateName') newTemplateName?: string) {
    return this.service.clone(id, newTemplateName);
  }

  @Get(':id/simulate')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Simulate salary calculation for a template with custom attendance or basic salary' })
  async simulate(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('customBasic') customBasic?: number,
    @Query('workingDays') workingDays?: number,
    @Query('presentDays') presentDays?: number,
  ) {
    return this.service.simulateCalculation(
      id,
      customBasic ? Number(customBasic) : undefined,
      workingDays ? Number(workingDays) : 30,
      presentDays ? Number(presentDays) : 30,
    );
  }
}
