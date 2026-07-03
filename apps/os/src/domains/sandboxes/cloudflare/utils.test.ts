import { describe, expect, it } from "vitest";
import { normalizeCloudflareSandboxPath } from "./utils.ts";

describe("normalizeCloudflareSandboxPath", () => {
  it("accepts full cloudflare sandbox paths", () => {
    expect(normalizeCloudflareSandboxPath("/sandboxes/cloudflare/whatever")).toBe(
      "/sandboxes/cloudflare/whatever",
    );
    expect(normalizeCloudflareSandboxPath("sandboxes/cloudflare/nested/name")).toBe(
      "/sandboxes/cloudflare/nested/name",
    );
  });

  it("rejects paths outside the cloudflare sandbox scope", () => {
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/other/x")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/agents/demo")).toThrow(/sandbox path must be/);
  });

  it("rejects the bare scope with no sandbox name", () => {
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare")).toThrow(
      /sandbox path must be/,
    );
  });
});
