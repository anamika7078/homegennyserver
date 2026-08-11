import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('App Version')
@Public()
@Controller({ path: 'app', version: '1' })
export class AppVersionController {
  @Get('version')
  @ApiOperation({ summary: 'Get mobile app version status and update info' })
  async getAppVersion(
    @Query('platform') platform?: string,
    @Query('version') versionCode?: string,
  ) {
    const currentCode = intParse(versionCode, 1);
    return {
      status: 'OK',
      minimumVersionCode: 1,
      latestVersionCode: currentCode,
      forceUpdate: false,
      updateUrl: 'https://homegenny.com',
      message: 'App is up to date',
    };
  }
}

function intParse(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const num = parseInt(val, 10);
  return isNaN(num) ? fallback : num;
}
