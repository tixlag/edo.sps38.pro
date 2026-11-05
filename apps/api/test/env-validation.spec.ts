import { describe, expect, it } from "vitest";
import { validateEnv } from "../src/config/env.validation";

const required = {
  DATABASE_URL: "mysql://test:test@localhost:3308/edo",
  JWT_SECRET: "test-secret",
};
describe("optional communications configuration", () => {
  it("rejects an enabled adaptation sync without both endpoint and token", () => {
    expect(() =>
      validateEnv({ ...required, EDO_ADAPTATION_SYNC_ENABLED: "true" }),
    ).toThrow("EDO_ADAPTATION");
    expect(
      validateEnv({
        ...required,
        EDO_ADAPTATION_SYNC_ENABLED: "true",
        EDO_ADAPTATION_EVENTS_URL: "https://example.test/events",
        EDO_ADAPTATION_SYNC_TOKEN: "secret",
      }).EDO_ADAPTATION_SYNC_ENABLED,
    ).toBe("true");
  });
  it("requires explicit independent arrival configuration and HTTPS in production", () => {
    expect(validateEnv(required).EDO_ARRIVAL_SYNC_ENABLED).toBe("false");
    expect(() =>
      validateEnv({ ...required, EDO_ARRIVAL_SYNC_ENABLED: "true" }),
    ).toThrow("EDO_ARRIVAL_CONTEXTS_URL");
    const enabled = {
      ...required,
      EDO_ARRIVAL_SYNC_ENABLED: "true",
      ERP_COMMUNICATIONS_URL: "https://erp.example.test/api",
      EDO_ARRIVAL_CONTEXTS_URL:
        "http://localhost/surveys-service/api/internal/edo/arrival-contexts",
      EDO_ADAPTATION_SYNC_TOKEN: "test",
    };
    expect(validateEnv(enabled).EDO_ARRIVAL_SYNC_ENABLED).toBe("true");
    expect(() => validateEnv({ ...enabled, NODE_ENV: "production" })).toThrow(
      "HTTPS",
    );
    expect(() =>
      validateEnv({
        ...enabled,
        EDO_ARRIVAL_CONTEXTS_URL: "https://example.test/wrong",
      }),
    ).toThrow("approved Surveys endpoint");
  });
  it.each([undefined, "", "   "])(
    "treats %j URLs as an unconfigured integration",
    (value) => {
      const env = validateEnv({
        ...required,
        ERP_COMMUNICATIONS_URL: value,
        LK_CHAT_BASE_URL: value,
      });
      expect(env.ERP_COMMUNICATIONS_URL).toBeUndefined();
      expect(env.LK_CHAT_BASE_URL).toBeUndefined();
    },
  );
  it.each(["ERP_COMMUNICATIONS_URL", "LK_CHAT_BASE_URL"])(
    "rejects a malformed nonempty %s with its configuration path",
    (name) => {
      expect(() => validateEnv({ ...required, [name]: "invalid-url" })).toThrow(
        name,
      );
    },
  );
});
