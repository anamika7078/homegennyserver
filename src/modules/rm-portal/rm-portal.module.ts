import { Module } from '@nestjs/common';
import { RmPortalService } from './rm-portal.service';
import { RmPortalController } from './rm-portal.controller';

@Module({
  providers: [RmPortalService],
  controllers: [RmPortalController]
})
export class RmPortalModule { }
