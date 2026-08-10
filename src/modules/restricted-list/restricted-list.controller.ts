import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { RestrictedListService } from './restricted-list.service';

interface AddRestrictedBody {
  staff_id?: string;
  aadhaar_number?: string;
  phone?: string;
  reason: string;
  notes?: string;
  // NOTE: intentionally no `added_by` here — actor identity must come from the
  // authenticated JWT (req.user.id), never from client-supplied request body.
  // A previous version accepted `added_by` from the body, letting the actor on a
  // restricted-list entry be forged.
}

interface CheckRestrictedBody {
  aadhaar_number: string;
  phone: string;
}

// Spec: Restricted List — BM=write, RM=read-only (used during intake routing),
// Admin=full, Staff/Client/Finance=no access.
@ApiTags('Restricted List')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller({ path: 'restricted-list', version: '1' })
export class RestrictedListController {
  constructor(private readonly service: RestrictedListService) { }

  @Post()
  @Roles(UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Add an entry to the restricted list (BM/Admin only)' })
  add(
    @Body() body: AddRestrictedBody,
    @Request() req: { user: { id: string } },
  ): Promise<Record<string, unknown>> {
    return this.service.add({ ...body, added_by: req.user.id });
  }

  @Post('check')
  @Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN)
  @ApiOperation({ summary: 'Check if Aadhaar/phone is on the restricted list' })
  check(@Body() body: CheckRestrictedBody): Promise<{ found: boolean; reason?: string }> {
    return this.service.check(body.aadhaar_number, body.phone);
  }
}
