import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { CompetencyService } from './competency.service';

@Controller('api/competency')
export class CompetencyController {
  constructor(private readonly competencyService: CompetencyService) {}

  @Post('evaluate')
  async evaluate(@Body() data: any) {
    return this.competencyService.evaluate(data);
  }

  @Get('history/:id')
  async getHistory(@Param('id') candidateId: string) {
    return this.competencyService.getHistory(candidateId);
  }
}
