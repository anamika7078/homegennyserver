import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EsicController } from './esic.controller';
import { EsicService } from './esic.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [EsicController],
  providers: [EsicService],
})
export class EsicModule {}
