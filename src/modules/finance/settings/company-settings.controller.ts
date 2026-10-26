import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, UserRole } from '../../auth/decorators/roles.decorator';
import { CompanySettingsService, type CompanySettingsInput } from './company-settings.service';

@ApiTags('Finance — Company & GST')
@ApiBearerAuth()
@Roles(UserRole.FINANCE, UserRole.ADMIN)
@Controller({ path: 'finance/settings/company', version: '1' })
export class CompanySettingsController {
  constructor(private readonly service: CompanySettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'HomeGenny’s GSTIN, state, SAC, GST rate and bank details',
    description:
      '`ready_for_tax_invoice` is false — and invoices are issued as Bills of Supply with no GST — ' +
      'until a valid GSTIN, state and SAC code are on file. `missing` says which.',
  })
  get() {
    return this.service.get();
  }

  @Put()
  @ApiOperation({
    summary: 'Update company & GST settings',
    description:
      'Only the fields sent are changed; an empty string clears one. The GSTIN is format-checked ' +
      'and must match the state. Applies to invoices raised (or recalculated) afterwards.',
  })
  update(@Body() body: CompanySettingsInput, @Req() req: { user?: { id?: string } }) {
    return this.service.update(body ?? {}, req.user?.id);
  }
}
