import { describe, expect, it } from "vitest";
import { validateEnv } from "../src/config/env.validation";

const required = {
  DATABASE_URL: "mysql://test:test@localhost:3308/edo",
  JWT_SECRET: "test-secret",
};
describe("optional communications configuration", () => {
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
