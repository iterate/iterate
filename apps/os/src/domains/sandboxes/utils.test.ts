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
    // Slack thread agents nest a dotted timestamp — must stay in lockstep.
    expect(normalizeSandboxPath("/agents/slack/C123/ts-1738000000.123456")).toBe(
      "/agents/slack/C123/ts-1738000000.123456",
    );
  });

  test("accepts any path the agent Durable Object can tolerate (codec-safe)", () => {
    // `@` survives URL parsing, so an agent can live here and its DO works —
    // the sandbox must not be stricter than the path it mirrors.
    expect(normalizeSandboxPath("/agents/foo@bar")).toBe("/agents/foo@bar");
  });

  test("adds the leading slash", () => {
    expect(normalizeSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  test("rejects the root path", () => {
    expect(() => normalizeSandboxPath("/")).toThrow(/non-root path/);
    expect(() => normalizeSandboxPath("")).toThrow(/non-root path/);
  });

  test("rejects paths that do not round-trip through the name codec", () => {
    // A space becomes %20 and `/x/../y` collapses to `/y`: two spellings would
    // otherwise mint two Durable Objects for one canonical identity.
    expect(() => normalizeSandboxPath("/foo/../bar")).toThrow(/round-trip|stable Durable Object/);
    expect(() => normalizeSandboxPath("/foo bar")).toThrow(/round-trip|stable Durable Object/);
  });
});
