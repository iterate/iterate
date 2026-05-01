import { describe, expect, it } from "vitest";
import { resolveNewStyleCloudflareAppBaseUrlFromEnv } from "./new-style-cloudflare-apps.ts";

describe("resolveNewStyleCloudflareAppBaseUrlFromEnv", () => {
  it("reads APP_CONFIG_BASE_URL without validating unrelated app config overrides", () => {
    expect(
      resolveNewStyleCloudflareAppBaseUrlFromEnv({
        APP_CONFIG_BASE_URL: "https://os2.iterate-preview-1.com",
        APP_CONFIG_EVENTS_BASE_URL: "https://events-preview-1.iterate.com",
        APP_CONFIG_PROJECT_HOSTNAME_BASES: '["iterate-preview-1.app"]',
        APP_CONFIG_SHARED_API_SECRET: "secret",
      }),
    ).toBe("https://os2.iterate-preview-1.com");
  });

  it("falls back to APP_CONFIG JSON", () => {
    expect(
      resolveNewStyleCloudflareAppBaseUrlFromEnv({
        APP_CONFIG: JSON.stringify({
          baseUrl: "https://semaphore.iterate-preview-1.com",
          sharedApiSecret: "secret",
        }),
      }),
    ).toBe("https://semaphore.iterate-preview-1.com");
  });
});
