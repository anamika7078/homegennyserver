import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceAnalyticsController } from './analytics.controller';
import { FinanceAnalyticsService } from './analytics.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [FinanceAnalyticsController],
  providers: [FinanceAnalyticsService],
})
export class AnalyticsModule {}
