import { describe, expect, test } from "vitest";
import { normalizeSandboxPath } from "./utils.ts";

describe("normalizeSandboxPath", () => {
  test("accepts /sandboxes/ paths, arbitrarily nested", () => {
    expect(normalizeSandboxPath("/sandboxes/cloudflare/whatever")).toBe(
      "/sandboxes/cloudflare/whatever",
    );
    expect(normalizeSandboxPath("/sandboxes/cloudflare/bla/bla")).toBe(
      "/sandboxes/cloudflare/bla/bla",
    );
    expect(normalizeSandboxPath("/sandboxes/cloudflare/builder")).toBe(
      "/sandboxes/cloudflare/builder",
    );
  });

  test("adds the leading slash", () => {
    expect(normalizeSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  test("rejects paths outside /sandboxes/", () => {
    expect(() => normalizeSandboxPath("/agents/demo")).toThrow(/sandbox path must start/);
    expect(() => normalizeSandboxPath("/sandboxes")).toThrow(/sandbox path must start/);
  });
});
