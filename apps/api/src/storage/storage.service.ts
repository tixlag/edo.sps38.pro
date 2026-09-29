import { Injectable } from '@nestjs/common';

/**
 * S3-compatible storage boundary (MinIO for local dev via docker-compose).
 * Binary document files live here — never in MariaDB.
 * TODO(storage): wire AWS SDK v3 with S3_* env once document upload slice lands.
 */
@Injectable()
export class StorageService {
  bucket(): string {
    return process.env.S3_BUCKET ?? 'edo-documents';
  }

  endpoint(): string {
    return process.env.S3_ENDPOINT ?? 'http://localhost:9000';
  }

  keyFor(documentId: string, version: number, filename: string): string {
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return `documents/${documentId}/v${version}/${safe}`;
  }
}
