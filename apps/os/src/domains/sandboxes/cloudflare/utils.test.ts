import { describe, expect, it } from "vitest";
import { normalizeCloudflareSandboxPath } from "./utils.ts";

describe("normalizeCloudflareSandboxPath", () => {
  it("accepts full cloudflare sandbox paths, arbitrarily nested", () => {
    expect(normalizeCloudflareSandboxPath("/sandboxes/cloudflare/whatever")).toBe(
      "/sandboxes/cloudflare/whatever",
    );
    expect(normalizeCloudflareSandboxPath("/sandboxes/cloudflare/bla/bla")).toBe(
      "/sandboxes/cloudflare/bla/bla",
    );
    expect(normalizeCloudflareSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  it("rejects paths outside the cloudflare sandbox scope", () => {
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/other/x")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/agents/demo")).toThrow(/sandbox path must be/);
  });

  it("rejects the bare prefix with no path segments under it", () => {
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare")).toThrow(
      /sandbox path must be/,
    );
  });

  it("rejects segments URL parsing would rewrite", () => {
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/x/../y")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/./x")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare//x")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/x?y")).toThrow(
      /sandbox path must be/,
    );
    expect(() => normalizeCloudflareSandboxPath("/sandboxes/cloudflare/x y")).toThrow(
      /sandbox path must be/,
    );
  });
});
