import { Controller, Get, Post, Put, Body, Param } from '@nestjs/common';
import { AssessmentsService } from './assessments.service';

@Controller({ path: 'assessments', version: '1' })
export class AssessmentsController {
  constructor(private readonly assessmentsService: AssessmentsService) {}

  @Get()
  async findAll() {
    return this.assessmentsService.findAll();
  }

  @Post('create')
  async create(@Body() data: any) {
    return this.assessmentsService.create(data);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.assessmentsService.findOne(id);
  }

  @Put('update/:id')
  async update(@Param('id') id: string, @Body() data: any) {
    return this.assessmentsService.update(id, data);
  }

  @Post('submit')
  async submit(@Body() data: any) {
    return this.assessmentsService.submit(data);
  }
}
