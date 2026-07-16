// Redaction/visibility kernels for the OS AppConfig. The generic `redacted`
// mechanism (inspect → "Redacted {}", exposeSecret gate) is proven in
// packages/shared/src/config.test.ts; these pin the os-level split: which
// fields stay readable and that secrets only come out through exposeSecret().
// The old parse-a-fixture-then-assert-its-fields-back acceptance tests were
// deleted — they restated the zod schema without exercising anything.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import { AppConfig } from "./config.ts";

const baseConfig = {
  openAiApiKey: "openai-api-key",
};

describe("AppConfig", () => {
  it("keeps TypeID prefix visible because it is not a secret", () => {
    const parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: {
        APP_CONFIG: JSON.stringify(baseConfig),
      },
    });

    expect(parsed.typeIdPrefix).toBe("os");
    expect(inspect(parsed)).toContain("typeIdPrefix: 'os'");
  });

  it("hides the admin API secret from inspect and yields it only via exposeSecret", () => {
    const parsed = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: {
        APP_CONFIG: JSON.stringify(baseConfig),
        APP_CONFIG_ADMIN_API_SECRET: "admin-api-secret-example",
      },
    });

    expect(inspect(parsed)).not.toContain("admin-api-secret-example");
    expect(parsed.adminApiSecret?.exposeSecret()).toEqual("admin-api-secret-example");
  });
});
