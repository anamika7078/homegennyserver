import { Controller, Get, Post, Query, Res, UseGuards, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { EsicService } from './esic.service';

@ApiTags('Finance — ESIC & PF')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'finance/esic', version: '1' })
export class EsicController {
  constructor(private readonly service: EsicService) {}

  @Get('challan')
  @ApiOperation({ summary: 'Generate ESIC challan for a given month/year' })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year',  required: true })
  async getEsicChallan(
    @Query('month', ParseIntPipe) month: number,
    @Query('year',  ParseIntPipe) year:  number,
  ) {
    return this.service.generateEsicChallan(month, year);
  }

  @Get('pf-ecr')
  @ApiOperation({ summary: 'Generate PF ECR for a given month/year' })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year',  required: true })
  async getPfEcr(
    @Query('month', ParseIntPipe) month: number,
    @Query('year',  ParseIntPipe) year:  number,
  ) {
    return this.service.generatePfEcr(month, year);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export ESIC or PF report as CSV for government filing' })
  @ApiQuery({ name: 'type',  required: true, enum: ['ESIC', 'PF'] })
  @ApiQuery({ name: 'month', required: true })
  @ApiQuery({ name: 'year',  required: true })
  async exportCsv(
    @Query('type')  type:  'ESIC' | 'PF',
    @Query('month', ParseIntPipe) month: number,
    @Query('year',  ParseIntPipe) year:  number,
    @Res() res: Response,
  ) {
    const data = type === 'ESIC'
      ? await this.service.generateEsicChallan(month, year)
      : await this.service.generatePfEcr(month, year);

    const csv = this.service.exportCsv(type, data.records as any, month, year);
    const filename = `HomeGenny_${type}_${month}_${year}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
