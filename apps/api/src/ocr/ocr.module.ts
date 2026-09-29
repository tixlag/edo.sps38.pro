import { Module } from '@nestjs/common';
import { RabbitmqOcrService } from './rabbitmq-ocr.service';
import { OcrService } from './ocr.service';

@Module({
  providers: [RabbitmqOcrService, { provide: OcrService, useExisting: RabbitmqOcrService }],
  exports: [OcrService],
})
export class OcrModule {}
