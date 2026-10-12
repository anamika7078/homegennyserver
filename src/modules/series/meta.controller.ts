import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { SERIES_CATALOG, isSeriesActive, isStage25Enabled } from '../../common/config/active-series';

/**
 * Reference lists the web and mobile apps read instead of hardcoding them.
 * Public because staff self-registration picks a series before any login.
 */
@ApiTags('Meta')
@Controller({ path: 'meta', version: '1' })
export class MetaController {
  @Get('series')
  @Public()
  @ApiOperation({
    summary: 'Staff series HomeGenny knows, and which are taken on right now',
    description:
      'Pickers that create NEW staff show only `active: true`. Lists and filters show all of them, ' +
      'because staff in a paused series (MAID, DRIVER) still exist. `value` is what every API takes ' +
      'and returns as series_db; `short` is the display code. `stage_2_5_enabled` says whether the ' +
      'S2_5_ASSESS stage is in use.',
  })
  series() {
    return {
      series: SERIES_CATALOG.map((s) => ({ ...s, active: isSeriesActive(s.value) })),
      stage_2_5_enabled: isStage25Enabled(),
    };
  }
}
