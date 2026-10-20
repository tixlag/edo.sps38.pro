import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpCommunicationsClient } from "../src/communications/erp-communications.client";

function client(token = "shared-incoming-test-token") {
  return new ErpCommunicationsClient(
    new ConfigService({
      ERP_COMMUNICATIONS_URL: "https://erp.example.invalid/communications",
      ERP_CANDIDATE_TOKEN: token,
      ERP_USERNAME: "service-user",
      ERP_PASSWORD: "test-password",
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ERP communications authentication", () => {
  it("authenticates with the existing Candidate token and service account", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(client().catalog()).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url.searchParams.get("action")).toBe("candidates");
    expect(options.headers).toMatchObject({
      token: "shared-incoming-test-token",
      Authorization: `Basic ${Buffer.from("service-user:test-password").toString("base64")}`,
    });
  });

  it("refuses to contact ERP without the shared token", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(client("").catalog()).rejects.toThrow(
      "ERP_COMMUNICATIONS_NOT_CONFIGURED",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
