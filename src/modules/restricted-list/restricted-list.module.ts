import { Module } from '@nestjs/common';
import { RestrictedListService } from './restricted-list.service';
import { RestrictedListController } from './restricted-list.controller';

@Module({
  providers: [RestrictedListService],
  controllers: [RestrictedListController],
  exports: [RestrictedListService],
})
export class RestrictedListModule {}