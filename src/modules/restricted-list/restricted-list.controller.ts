import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RestrictedListService } from './restricted-list.service';

interface AddRestrictedBody {
  staff_id?: string;
  aadhaar_number?: string;
  phone?: string;
  reason: string;
  added_by: string;
  notes?: string;
}

interface CheckRestrictedBody {
  aadhaar_number: string;
  phone: string;
}

@ApiTags('Restricted List')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'restricted-list', version: '1' })
export class RestrictedListController {
  constructor(private readonly service: RestrictedListService) { }

  @Post()
  @ApiOperation({ summary: 'Add an entry to the restricted list (BM only)' })
  add(@Body() body: AddRestrictedBody): Promise<Record<string, unknown>> {
    return this.service.add(body);
  }

  @Post('check')
  @ApiOperation({ summary: 'Check if Aadhaar/phone is on the restricted list' })
  check(@Body() body: CheckRestrictedBody): Promise<{ found: boolean; reason?: string }> {
    return this.service.check(body.aadhaar_number, body.phone);
  }
}
