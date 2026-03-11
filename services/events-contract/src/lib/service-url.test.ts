import { describe, expect, it } from "vitest";
import {
  resolveServiceBaseUrl,
  resolveServiceOrpcUrl,
  resolveServiceOrpcWebSocketUrl,
  type ServiceManifestLike,
} from "./service-url.ts";

const manifest: ServiceManifestLike = {
  slug: "events",
  port: 17320,
  orpcContract: {},
};

describe("resolveServiceBaseUrl", () => {
  it("prefers explicit self origin for same-service browser clients", () => {
    expect(
      resolveServiceBaseUrl({
        env: {
          ITERATE_PROJECT_BASE_URL: "https://ignored.example.com",
        },
        manifest,
        preferSameOrigin: true,
      }),
    ).toBe("https://ignored.example.com/");
  });
});

describe("resolveServiceOrpc*", () => {
  it("keeps orpc fetch traffic on same origin when self origin is provided", () => {
    expect(
      resolveServiceOrpcUrl({
        env: {
          ITERATE_PROJECT_BASE_URL:
            "https://events.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com",
        },
        manifest,
        preferSameOrigin: true,
      }),
    ).toBe("https://events.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com/orpc");
  });

  it("keeps websocket traffic on same origin when self origin is provided", () => {
    expect(
      resolveServiceOrpcWebSocketUrl({
        env: {
          ITERATE_PROJECT_BASE_URL:
            "https://events.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com",
        },
        manifest,
        preferSameOrigin: true,
      }),
    ).toBe("wss://events.iterate.iterate-e2e-test-custom-domain-no-cloudflare.com/orpc/ws/");
  });
});
