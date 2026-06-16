import { Module } from '@nestjs/common';
import { PfController } from './pf.controller';
import { PfService } from './pf.service';

@Module({
  controllers: [PfController],
  providers: [PfService]
})
export class PfModule {}
