import type { ConfigService } from "@nestjs/config";

/** Both credentials are server-only. Never log these headers or response bodies. */
export function erpDocumentHeaders(
  config: ConfigService,
): Record<string, string> {
  const token = config.get<string>("ERP_DOCUMENTS_TOKEN");
  const username = config.get<string>("ERP_USERNAME");
  const password = config.get<string>("ERP_PASSWORD");
  if (!token || !username || !password) throw new Error("ERP_NOT_CONFIGURED");
  return {
    token,
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}
