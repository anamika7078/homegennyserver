import { Controller, Post, Body } from '@nestjs/common';
import { DriverTestsService } from './driver-tests.service';

@Controller('api/driver-tests')
export class DriverTestsController {
  constructor(private readonly driverTestsService: DriverTestsService) {}

  @Post('start')
  async start(@Body() data: any) {
    return this.driverTestsService.start(data);
  }

  @Post('score')
  async score(@Body() data: any) {
    return this.driverTestsService.score(data);
  }

  @Post('complete')
  async complete(@Body() data: any) {
    return this.driverTestsService.complete(data);
  }
}
