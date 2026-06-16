import { Controller, Post, Get, Put, Body, Param } from '@nestjs/common';
import { SchedulesService } from './schedules.service';

@Controller('api/schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Post('create')
  async create(@Body() data: any) {
    return this.schedulesService.create(data);
  }

  @Get('upcoming')
  async getUpcoming() {
    return this.schedulesService.getUpcoming();
  }

  @Put('reschedule/:id')
  async reschedule(@Param('id') id: string, @Body() data: any) {
    return this.schedulesService.reschedule(id, data);
  }
}
