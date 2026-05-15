import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlacementService, PlacementRow, PlacementList } from './placement.service';

@ApiTags('Placements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'placements', version: '1' })
export class PlacementController {
  constructor(private readonly service: PlacementService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new placement (trial)' })
  create(@Body() body: Record<string, unknown>): Promise<PlacementRow> {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'List all placements' })
  findAll(@Query() q: Record<string, string>): Promise<PlacementList> {
    return this.service.findAll({
      limit:  q['limit']  ? parseInt(q['limit'],  10) : 100,
      offset: q['offset'] ? parseInt(q['offset'], 10) : 0,
    });
  }

  @Post(':id/exit')
  @ApiOperation({ summary: 'Exit a placement' })
  exit(
    @Param('id') id: string,
    @Body() body: { exit_date: string; exit_scenario_code: string },
  ): Promise<{ success: boolean }> {
    return this.service.exit(id, body);
  }
}
