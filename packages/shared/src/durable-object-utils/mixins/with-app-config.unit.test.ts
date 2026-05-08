import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppConfigTestRoom } from "../test-harness/initialize-fronting-worker.ts";

const testEnv = env as {
  APP_CONFIG_ROOMS: DurableObjectNamespace<AppConfigTestRoom>;
};

describe("withAppConfig", () => {
  it("parses APP_CONFIG and APP_CONFIG_* overrides from the Cloudflare env", async () => {
    const room = testEnv.APP_CONFIG_ROOMS.getByName(`app-config-${crypto.randomUUID()}`);

    await expect(room.getConfigForTest()).resolves.toEqual({
      serviceName: "override-service",
      feature: {
        enabled: true,
        limit: 4,
      },
      integrations: {
        posthog: {
          projectApiKey: "override-posthog-key",
          captureEndpoint: "https://base.example.com/capture",
          sampling: {
            enabled: true,
            rate: 0.5,
          },
        },
      },
      limits: {
        queue: {
          maxBatchSize: 25,
          tags: ["override", "nested"],
        },
      },
      optionalText: "default-text",
    });
  });

  it("documents nested APP_CONFIG_* path and JSON object override semantics", async () => {
    const room = testEnv.APP_CONFIG_ROOMS.getByName(`app-config-nested-${crypto.randomUUID()}`);

    const config = await room.getConfigForTest();

    expect(config.integrations.posthog).toEqual({
      projectApiKey: "override-posthog-key",
      captureEndpoint: "https://base.example.com/capture",
      sampling: {
        enabled: true,
        rate: 0.5,
      },
    });
    expect(config.limits.queue).toEqual({
      maxBatchSize: 25,
      tags: ["override", "nested"],
    });
  });

  it("caches parsed config for one Durable Object wake", async () => {
    const room = testEnv.APP_CONFIG_ROOMS.getByName(`app-config-cache-${crypto.randomUUID()}`);

    await expect(room.getConfigReferenceStableForTest()).resolves.toBe(true);
  });
});
