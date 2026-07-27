import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { CommercialService, WageConfigDto, CreateCalculationDto, CreateQuotationDto } from './commercial.service';

@ApiTags('Finance — Commercial')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/commercial', version: '1' })
export class CommercialController {
  constructor(private readonly service: CommercialService) {}

  // ─── WAGE CONFIGURATIONS ─────────────────────────────────────────────────

  @Get('wage-config')
  @ApiOperation({ summary: 'List all wage configs' })
  @ApiQuery({ name: 'search', required: false })
  listWageConfigs(@Query('search') search?: string) {
    return this.service.listWageConfigs(search);
  }

  @Post('wage-config')
  @ApiOperation({ summary: 'Create a new wage configuration' })
  createWageConfig(@Body() body: WageConfigDto) {
    return this.service.createWageConfig(body);
  }

  @Get('wage-config/categories')
  @ApiOperation({ summary: 'Get active/default categories' })
  getWageCategories() {
    return this.service.getWageCategories();
  }

  @Get('wage-config/active')
  @ApiOperation({ summary: 'Get active wage config for state, zone, category' })
  getActiveWageConfig(
    @Query('state') state: string,
    @Query('zone') zone: string,
    @Query('category') category: string,
    @Query('date') date?: string,
  ) {
    return this.service.getActiveWageConfig(state, zone, category, date);
  }

  @Get('wage-config/comparison')
  @ApiOperation({ summary: 'Compare revisions' })
  getWageRevisionComparison(
    @Query('state') state: string,
    @Query('zone') zone: string,
    @Query('category') category: string,
  ) {
    return this.service.getWageRevisionComparison(state, zone, category);
  }

  // ─── COMMERCIAL CALCULATIONS ─────────────────────────────────────────────

  @Get('calculations')
  @ApiOperation({ summary: 'List calculations' })
  @ApiQuery({ name: 'search', required: false })
  listCalculations(@Query('search') search?: string) {
    return this.service.listCalculations(search);
  }

  @Post('calculations/calculate')
  @ApiOperation({ summary: 'Run temporary calculations on-the-fly' })
  runCalculationOnTheFly(@Body() body: any) {
    return this.service.runCalculationOnTheFly(body);
  }

  @Post('calculations')
  @ApiOperation({ summary: 'Create a commercial calculation sheet' })
  createCalculation(@Body() body: CreateCalculationDto, @Req() req: any) {
    return this.service.createCalculation(body, req.user);
  }

  @Get('calculations/:id')
  @ApiOperation({ summary: 'Get calculation sheet by ID' })
  getCalculation(@Param('id') id: string) {
    return this.service.getCalculation(id);
  }

  // ─── APPROVAL FLOW ───────────────────────────────────────────────────────

  @Post('calculations/:id/submit')
  @ApiOperation({ summary: 'Submit calculation sheet for review' })
  submitForApproval(@Param('id') id: string, @Req() req: any) {
    return this.service.submitForApproval(id, req.user);
  }

  @Post('calculations/:id/approve')
  @ApiOperation({ summary: 'Approve calculation' })
  approveCalculation(
    @Param('id') id: string,
    @Body('comments') comments: string,
    @Req() req: any,
  ) {
    return this.service.approveCalculation(id, comments, req.user);
  }

  @Post('calculations/:id/reject')
  @ApiOperation({ summary: 'Reject calculation' })
  rejectCalculation(
    @Param('id') id: string,
    @Body('comments') comments: string,
    @Req() req: any,
  ) {
    return this.service.rejectCalculation(id, comments, req.user);
  }

  // ─── QUOTATIONS ──────────────────────────────────────────────────────────

  @Get('quotations')
  @ApiOperation({ summary: 'List all quotations' })
  listQuotations() {
    return this.service.listQuotations();
  }

  @Post('quotations')
  @ApiOperation({ summary: 'Generate a new quotation' })
  createQuotation(@Body() body: CreateQuotationDto, @Req() req: any) {
    return this.service.createQuotation(body, req.user);
  }

  @Get('quotations/:id')
  @ApiOperation({ summary: 'Get quotation by ID' })
  getQuotation(@Param('id') id: string) {
    return this.service.getQuotation(id);
  }

  // ─── RATE CARDS ──────────────────────────────────────────────────────────

  @Get('rate-cards')
  @ApiOperation({ summary: 'List rate cards' })
  @ApiQuery({ name: 'search', required: false })
  listRateCards(@Query('search') search?: string) {
    return this.service.listRateCards(search);
  }

  // ─── REPORTS ─────────────────────────────────────────────────────────────

  @Get('reports')
  @ApiOperation({ summary: 'Get report statistics' })
  getReports() {
    return this.service.getReports();
  }
}
