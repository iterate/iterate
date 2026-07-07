import { describe, expect, it } from "vitest";
import { resolveIterateAuthResource } from "./iterate-auth-client.ts";

describe("resolveIterateAuthResource", () => {
  it("uses the portless loopback origin when local dev has no configured base URL", () => {
    expect(
      resolveIterateAuthResource({
        requestUrl: "http://localhost:49915/api/iterate-auth/session-from-token",
      }),
    ).toBe("http://localhost");
  });

  it("normalizes configured loopback resources the same way as auth:mint", () => {
    expect(
      resolveIterateAuthResource({
        baseUrl: "http://localhost:49915",
        requestUrl: "http://localhost:49915/api/iterate-auth/session-from-token",
      }),
    ).toBe("http://localhost");
  });

  it("preserves non-loopback origins", () => {
    expect(
      resolveIterateAuthResource({
        requestUrl: "https://misha.tunnels.iterate.com/api/iterate-auth/session-from-token",
      }),
    ).toBe("https://misha.tunnels.iterate.com");
  });

  it("lets an explicit auth resource override the app URL", () => {
    expect(
      resolveIterateAuthResource({
        authResource: "https://os.iterate.com/",
        baseUrl: "http://localhost:49915",
        requestUrl: "http://localhost:49915/api/iterate-auth/session-from-token",
      }),
    ).toBe("https://os.iterate.com");
  });
});
