import { Module } from '@nestjs/common';
import { BonusController } from './bonus.controller';
import { BonusService } from './bonus.service';
import { BonusRepository } from './bonus.repository';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BonusController],
  providers: [BonusService, BonusRepository],
  exports: [BonusService, BonusRepository],
})
export class BonusModule {}
