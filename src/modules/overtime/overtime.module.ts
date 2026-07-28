import { Module } from '@nestjs/common';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { OvertimeRepository } from './overtime.repository';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [OvertimeController],
  providers: [OvertimeService, OvertimeRepository],
  exports: [OvertimeService, OvertimeRepository],
})
export class OvertimeModule {}
