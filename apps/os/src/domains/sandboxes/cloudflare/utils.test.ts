import { describe, expect, it } from "vitest";
import { normalizeSandboxPath } from "./utils.ts";

describe("normalizeSandboxPath", () => {
  it("accepts any non-root path, arbitrarily nested", () => {
    expect(normalizeSandboxPath("/sandboxes/cloudflare/whatever")).toBe(
      "/sandboxes/cloudflare/whatever",
    );
    expect(normalizeSandboxPath("/agents/slack/C0123/ts-124.5")).toBe(
      "/agents/slack/C0123/ts-124.5",
    );
    expect(normalizeSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  it("rejects the root path", () => {
    expect(() => normalizeSandboxPath("/")).toThrow(/sandbox path must be/);
    expect(() => normalizeSandboxPath("")).toThrow(/sandbox path must be/);
  });

  it("rejects segments URL parsing would rewrite", () => {
    expect(() => normalizeSandboxPath("/agents/x/../y")).toThrow(/sandbox path must be/);
    expect(() => normalizeSandboxPath("/agents/./x")).toThrow(/sandbox path must be/);
    expect(() => normalizeSandboxPath("/agents//x")).toThrow(/sandbox path must be/);
    expect(() => normalizeSandboxPath("/agents/x?y")).toThrow(/sandbox path must be/);
    expect(() => normalizeSandboxPath("/agents/x y")).toThrow(/sandbox path must be/);
  });
});
