import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MusterRollService } from './muster-roll.service';
import { ClientMusterRollController, MusterRollController } from './muster-roll.controller';

/** The Form XVI muster roll: built from attendance, signed by the client in the app or on paper. */
@Module({
  imports: [PrismaModule],
  controllers: [MusterRollController, ClientMusterRollController],
  providers: [MusterRollService],
  exports: [MusterRollService],
})
export class MusterRollModule {}
