import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentExpirationService } from "./document-expiration.service";

@Injectable()
export class ExpirationRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpirationRetryWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  constructor(private readonly service: DocumentExpirationService, private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (this.config.get<string>("CONTRACT_NOTIFICATION_WORKER_ENABLED") !== "true") return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try { await this.service.retryDueAlerts(); }
    catch { this.logger.warn("Expiration alert recovery failed; will retry"); }
    finally { this.running = false; }
  }
}
