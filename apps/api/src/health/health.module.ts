import { Module, Optional } from '@nestjs/common';
import { HealthController } from './health.controller';
import { LkSyncModule } from '../lk-sync/lk-sync.module';

@Module({ imports: [LkSyncModule], controllers: [HealthController] })
export class HealthModule {
  constructor(@Optional() private readonly _sync?: unknown) {
    void this._sync;
  }
}
