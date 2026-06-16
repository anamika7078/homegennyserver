import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositController } from './deposit.controller';
import { DepositService } from './deposit.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [DepositController],
  providers: [DepositService],
})
export class DepositModule {}
