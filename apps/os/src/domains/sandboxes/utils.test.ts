import { describe, expect, test } from "vitest";
import { normalizeSandboxPath } from "./utils.ts";

describe("normalizeSandboxPath", () => {
  test("accepts any non-root path, arbitrarily nested", () => {
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

  test("accepts agent paths — a sandbox at the agent's own path", () => {
    // This is `itx.sandbox`: the sandbox NAMES the agent stream at the same
    // path (its own Durable Object namespace, so no collision).
    expect(normalizeSandboxPath("/agents/demo")).toBe("/agents/demo");
    expect(normalizeSandboxPath("/agents/bla/bla/bla")).toBe("/agents/bla/bla/bla");
  });

  test("adds the leading slash", () => {
    expect(normalizeSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  test("rejects the root path and illegal segments", () => {
    expect(() => normalizeSandboxPath("/")).toThrow(/non-root path/);
    expect(() => normalizeSandboxPath("")).toThrow(/non-root path/);
    expect(() => normalizeSandboxPath("/foo/../bar")).toThrow(/non-root path/);
    expect(() => normalizeSandboxPath("/foo bar")).toThrow(/non-root path/);
  });
});
