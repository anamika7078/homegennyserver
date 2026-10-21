import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SnapshotService } from './snapshot.service';
import { ClientSnapshotController, RmSnapshotController } from './snapshot.controller';

/** Staff snapshot for the RM web and the client app — docs/STAFF_SNAPSHOT_PLAN.md. Read-only. */
@Module({
  imports: [PrismaModule],
  controllers: [RmSnapshotController, ClientSnapshotController],
  providers: [SnapshotService],
})
export class SnapshotModule {}
