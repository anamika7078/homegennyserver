import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OnboardingService } from './onboarding.service';

type Req = { user: { id: string; role: string } };

const STAFF_PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    full_name: { type: 'string', example: 'Rekha Devi' },
    date_of_birth: { type: 'string', example: '1992-03-04', description: 'YYYY-MM-DD, age 18–65' },
    gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'] },
    series: { type: 'string', enum: ['UC', 'SC', 'CK'] },
    address: { type: 'string', example: '14 Lajpat Nagar' },
    city: { type: 'string', example: 'Delhi NCR', description: 'From GET /meta/cities, or "Other"' },
    area: { type: 'string', example: 'South Delhi' },
    pincode: { type: 'string', example: '110024' },
    emergency_contact_name: { type: 'string', example: 'Suresh (husband)' },
    emergency_contact_mobile: { type: 'string', example: '9876500000', description: 'Not your own number' },
    languages: { type: 'array', items: { type: 'string' }, example: ['Hindi', 'English'] },
    alternate_phone: { type: 'string' },
    email: { type: 'string' },
    experience_years: { type: 'integer', example: 3 },
    father_or_husband_name: { type: 'string', example: 'Ramesh Kumar', description: 'For the muster roll (Form XVI). Optional; 2–150 letters.' },
  },
};

@ApiTags('Onboarding', 'Mobile App Auth APIs')
@ApiBearerAuth()
@Roles(UserRole.CLIENT, UserRole.STAFF)
@Controller({ path: 'me', version: '1' })
export class MeOnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  @Get('onboarding')
  @ApiOperation({
    summary: 'What the app should show next: COMPLETE_PROFILE → (staff) WAIT_FOR_RM / VERIFICATION → READY',
    description:
      '{ role, profile_complete, missing[], next_step, rm }. Until profile_complete, every write except the profile ' +
      'routes is refused with 403 PROFILE_INCOMPLETE. docs/REGISTRATION_ONBOARDING_PLAN.md.',
  })
  status(@Req() req: Req) {
    return this.svc.status(req.user);
  }
}

@ApiTags('Onboarding', 'Mobile App Auth APIs')
@Controller({ path: 'meta', version: '1' })
export class MetaCitiesController {
  constructor(private readonly svc: OnboardingService) {}

  @Get('cities')
  @Public()
  @ApiOperation({ summary: 'Cities HomeGenny works in (one per active branch) with their areas, plus "Other" — the profile city dropdown' })
  cities() {
    return this.svc.cities();
  }
}

@ApiTags('Staff Mobile App', 'Mobile App Staff APIs')
@ApiBearerAuth()
@Roles(UserRole.STAFF)
@Controller({ path: 'staff', version: '1' })
export class StaffProfileController {
  constructor(private readonly svc: OnboardingService) {}

  @Get('profile')
  @ApiOperation({
    summary: 'My profile — real values only (blank = null), plus profile_complete, missing[] and locked_fields[]',
  })
  profile(@Req() req: Req) {
    return this.svc.staffProfile(req.user.id);
  }

  @Put('profile')
  @ApiOperation({
    summary: 'Save my profile (draft): any subset of fields, each checked',
    description:
      'Name, DOB, gender and category are locked once S2 has started ("ask your RM"). Returns the same shape as GET.',
  })
  @ApiBody({ schema: STAFF_PROFILE_SCHEMA })
  save(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.svc.saveStaffProfile(req.user.id, body ?? {});
  }

  @Post('profile/submit')
  @ApiOperation({
    summary: 'Submit my profile: S1 done → S2 Verification, and an RM is assigned',
    description:
      'Saves what is sent, then every required field must be filled (400 PROFILE_INCOMPLETE with missing[] ' +
      'otherwise). outcome ADVANCE_S2 (with assigned: { id, name } or null when no RM is in the city — the RM web ' +
      'Leads list picks it up) or RESTRICTED. Returns the onboarding status too.',
  })
  @ApiBody({ schema: STAFF_PROFILE_SCHEMA })
  submit(@Req() req: Req, @Body() body: Record<string, unknown>) {
    return this.svc.submitStaffProfile(req.user.id, body ?? {});
  }
}
