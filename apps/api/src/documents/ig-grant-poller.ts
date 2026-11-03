import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { IgEmploymentService } from "./ig-employment.service";
import { CandidateWorkspaceService } from "../communications/candidate-workspace.service";

const eventSchema = z.object({
  id: z.string().uuid(),
  employeeCode1c: z.string().regex(/^\S{1,64}$/),
  citizenship: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .refine((v) => v.toLowerCase() !== "ru"),
  createdAt: z.string().datetime(),
});
async function readEvents(response: Response) {
  if (!response.body) throw new Error("Missing adaptation event body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 256 * 1024)
        throw new Error("Adaptation event response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return z
    .array(z.unknown())
    .max(100)
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

@Injectable()
export class IgGrantPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgGrantPoller.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private cursor?: string;
  constructor(
    private readonly config: ConfigService,
    private readonly employment: IgEmploymentService,
    @Optional() private readonly workspace?: CandidateWorkspaceService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>("EDO_ADAPTATION_SYNC_ENABLED") !== "true")
      return;
    if (
      !this.config.get<string>("EDO_ADAPTATION_EVENTS_URL") ||
      !this.config.get<string>("EDO_ADAPTATION_SYNC_TOKEN")
    )
      return;
    const tick = () =>
      void this.sync().catch(() =>
        this.logger.warn("Adaptation event synchronization failed"),
      );
    tick();
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    const url = this.config.get<string>("EDO_ADAPTATION_EVENTS_URL");
    const token = this.config.get<string>("EDO_ADAPTATION_SYNC_TOKEN");
    if (!url || !token)
      throw new Error("Adaptation event synchronization is not configured");
    const endpoint = new URL(url);
    if (
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          this.config.get("NODE_ENV") !== "production"
        ))
    )
      throw new Error("Invalid adaptation event endpoint");
    if (this.cursor) endpoint.searchParams.set("after", this.cursor);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Adaptation event source unavailable");
    const raw = await readEvents(response);
    const ids: string[] = [];
    for (const item of raw) {
      const parsed = eventSchema.safeParse(item);
      if (!parsed.success) {
        this.logger.warn("Invalid adaptation event retained for retry");
        continue;
      }
      try {
        const candidateId = await this.employment.applyGrant(parsed.data);
        if (this.workspace)
          await this.workspace.previous(candidateId, {
            uuid: "system:adaptation",
            code1c: null,
            sid: null,
            deviceId: null,
            expiresAt: null,
            accessRules: { "20011": [] },
          });
        ids.push(parsed.data.id);
      } catch {
        this.logger.warn("Adaptation event could not be applied");
      }
    }
    const last =
      raw.length === 100
        ? z.object({ id: z.string().uuid() }).safeParse(raw[raw.length - 1])
        : null;
    this.cursor = last?.success ? last.data.id : undefined;
    if (!ids.length) return;
    const ackUrl = new URL(`${url.replace(/\/$/, "")}/acknowledge`);
    const ack = await fetch(ackUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!ack.ok) throw new Error("Adaptation event acknowledgment failed");
  }
}
