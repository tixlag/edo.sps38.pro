import { Injectable, Logger } from '@nestjs/common';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { OcrService, type OcrRequest } from './ocr.service';

/**
 * OCR enqueue via shared RabbitMQ (NOT BullMQ).
 * BullMQ was removed as the primary queue mechanism: the ecosystem already
 * provides RabbitMQ, Redis stays for cache/locks only.
 * NOTE: if a future external OCR contract mandates BullMQ, reintroduce it
 * behind config and document here. Current contract is adapter-owned.
 */
@Injectable()
export class RabbitmqOcrService extends OcrService {
  private readonly logger = new Logger(RabbitmqOcrService.name);
  constructor(private readonly rabbitmq: RabbitmqService) {
    super();
  }

  async enqueue(request: OcrRequest): Promise<void> {
    const payload = {
      documentId: request.documentId,
      version: request.version,
      storageKey: request.storageKey,
    };
    try {
      await this.rabbitmq.publish('edo.ocr.requested.v1', payload);
    } catch (err) {
      this.logger.error(`OCR enqueue failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
