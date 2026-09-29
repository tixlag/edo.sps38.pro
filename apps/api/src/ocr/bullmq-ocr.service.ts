import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OcrService, type OcrRequest } from './ocr.service';

@Injectable()
export class BullMqOcrService extends OcrService {
  constructor(@InjectQueue('ocr') private readonly ocrQueue: Queue) {
    super();
  }

  async enqueue(request: OcrRequest): Promise<void> {
    // TODO(ocr): replace job payload with the real OCR contract.
    await this.ocrQueue.add('ocr', request, { jobId: `${request.documentId}-v${request.version}` });
  }
}
