import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AppConfig } from "./app.ts";

describe("AppConfig", () => {
  it("keeps TypeID prefix visible because it is not a secret", () => {
    const parsed = AppConfig.parse({
      pirateSecret: "ahoy",
      posthog: {
        apiKey: "phc_public_key",
      },
    });

    expect(parsed.typeId.prefix).toBe("example");
    expect(inspect(parsed)).toContain("prefix: 'example'");
    expect(inspect(parsed)).toContain("pirateSecret: Redacted {}");
  });
});
