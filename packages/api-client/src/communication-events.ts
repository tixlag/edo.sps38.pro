import type { ChatStreamGrantDto } from "./generated/api";

/** Transport only. Grants and REST reads use the generated client. No token in URLs. */
export function subscribeCommunicationUpdates(options: {
  connect: () => Promise<ChatStreamGrantDto>;
  onChange: () => void;
  onState: (state: "connecting" | "connected" | "reconnecting") => void;
}): () => void {
  let stopped = false,
    delay = 1000;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller?.abort(), 20000);
    };
    options.onState(delay === 1000 ? "connecting" : "reconnecting");
    try {
      const grant = await options.connect();
      if (stopped) return;
      controller = new AbortController();
      heartbeat();
      const response = await fetch(grant.url, {
        headers: {
          Authorization: `Bearer ${grant.token}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Stream unavailable");
      }
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await response.body.cancel();
        throw new Error("Invalid stream");
      }
      options.onState("connected");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      const connectedAt = Date.now();
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          heartbeat();
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(
            /\r\n/g,
            "\n",
          );
          if (buffer.length > 65536) throw new Error("Stream event too large");
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (
              frame.split("\n").some((line) => line.trim() === "event: changed")
            )
              options.onChange();
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        if (Date.now() - connectedAt > 30000) delay = 1000;
      }
    } catch {
      /* REST remains available; backoff also bounds failed grant requests. */
    } finally {
      clearTimeout(idle);
    }
    if (!stopped) {
      options.onState("reconnecting");
      timer = setTimeout(() => void run(), delay);
      delay = Math.min(delay * 2, 30000);
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
