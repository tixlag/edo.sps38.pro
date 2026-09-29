import { Module } from '@nestjs/common';
import { BullMqOcrService } from './bullmq-ocr.service';
import { OcrService } from './ocr.service';

@Module({
  providers: [
    BullMqOcrService,
    { provide: OcrService, useExisting: BullMqOcrService },
  ],
  exports: [OcrService],
})
export class OcrModule {}
