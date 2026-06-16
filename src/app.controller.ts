import { Controller, Get, Head, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({
  version: VERSION_NEUTRAL,
})
export class AppController {
  @Get()
  getHello() {
    return {
      message: 'HomeGenny API is live',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Head()
  headHello() {
    return;
  }
}
