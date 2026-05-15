import { Module } from '@nestjs/common';
import { VideoCertService } from './video-cert.service';
import { VideoCertController } from './video-cert.controller';

@Module({
  providers: [VideoCertService],
  controllers: [VideoCertController],
  exports: [VideoCertService],
})
export class VideoCertModule {}
