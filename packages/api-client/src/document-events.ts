import type { DocumentListDto } from "./generated/api";

/** SSE transport only; REST requests and contract types come from generated clients. */
export function subscribeDocumentStatuses(options: {
  connect: (reconnecting: boolean) => Promise<{ url: string; token: string }>;
  onDocuments: (documents: DocumentListDto) => void;
  onState?: (state: "connecting" | "connected" | "reconnecting") => void;
}): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnecting = false;
  const run = async () => {
    options.onState?.(reconnecting ? "reconnecting" : "connecting");
    try {
      const connection = await options.connect(reconnecting);
      if (stopped) return;
      controller = new AbortController();
      const response = await fetch(connection.url, {
        headers: {
          Authorization: `Bearer ${connection.token}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        cache: "no-store",
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new Error("Document stream unavailable");
      options.onState?.("connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!stopped) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          if (buffer.length > 2 * 1024 * 1024)
            throw new Error("Document stream event too large");
          let index;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (
              frame
                .split("\n")
                .some((line) => line.trim() === "event: documents")
            ) {
              const payload = frame
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              const data = JSON.parse(payload) as DocumentListDto;
              if (!Array.isArray(data.items))
                throw new Error("Invalid document stream");
              options.onDocuments(data);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      /* Status reads remain available; reconnect with a new token. */
    }
    if (!stopped) {
      reconnecting = true;
      options.onState?.("reconnecting");
      timer = setTimeout(() => void run(), 3000);
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(timer);
  };
}
