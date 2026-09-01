import { Controller, Get, Post, Query, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { StatutoryTaxService } from './statutory-tax.service';

@ApiTags('Finance — Tax Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/tax', version: '1' })
export class TaxController {
  constructor(private readonly service: StatutoryTaxService) {}

  @Get('professional-tax')
  @ApiOperation({
    summary: 'Professional-tax rules by state',
    description:
      'PT is levied by the state, not the country — Delhi and Haryana do not levy it at all. ' +
      'A state with no rule on file deducts nothing and is reported as unknown, which is not ' +
      'the same as a state that levies nothing.',
  })
  professionalTax() {
    return this.service.listPtRules();
  }

  @Get('income-tax')
  @ApiOperation({
    summary: 'Income-tax slabs used for TDS',
    description: '`confirmed` is false until Finance has verified the seeded figures.',
  })
  @ApiQuery({ name: 'financialYear', required: false })
  incomeTax(@Query('financialYear') fy?: string) {
    return this.service.listIncomeTaxSlabs(fy);
  }

  @Get('status')
  @ApiOperation({ summary: 'Whether the seeded tax rates have been signed off' })
  async status() {
    const confirmed = await this.service.ratesConfirmed();
    return {
      confirmed,
      message: confirmed
        ? 'Tax rates have been confirmed by Finance.'
        : 'Tax rates are seeded defaults and have not been verified. Payroll will still run, but every figure is flagged.',
    };
  }

  @Post('confirm')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Mark the tax rates as verified',
    description:
      'Deliberate and auditable: it asserts that someone has checked the seeded slabs against ' +
      'the current Budget and the relevant state notifications.',
  })
  confirm(@Req() req: { user?: { id?: string } }) {
    return this.service.confirmRates(req.user?.id);
  }

  @Post('preview')
  @ApiOperation({
    summary: 'What PT and TDS would be for a given salary',
    description: 'Lets Finance check a rule change against a real figure before payroll runs.',
  })
  async preview(
    @Body() body: { state?: string; monthly_gross: number; month: number; year: number; gender?: string; employee_id?: string },
  ) {
    const [pt, tds] = await Promise.all([
      this.service.professionalTax({
        state: body.state, monthlyGross: body.monthly_gross, month: body.month, gender: body.gender,
      }),
      this.service.tds({
        employeeId: body.employee_id ?? null, monthlyGross: body.monthly_gross,
        month: body.month, year: body.year,
      }),
    ]);
    return { professional_tax: pt, tds };
  }

  @Get('pf-base')
  @ApiOperation({
    summary: 'How the PF base is derived, and what changing it would cost',
    description:
      'Three different PF bases were in use at once — the client was quoted PF on one figure ' +
      'while payroll deducted another. This reports the current rule and, per placement, what ' +
      'the two rules give.',
  })
  pfBase() {
    return this.service.pfBaseImpact();
  }
}
