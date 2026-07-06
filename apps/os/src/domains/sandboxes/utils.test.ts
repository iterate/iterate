import { describe, expect, test } from "vitest";
import { agentPathForSandbox, agentSandboxPath, normalizeSandboxPath } from "./utils.ts";

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

  test("agent sandboxes live at the agent path under /sandboxes", () => {
    // This is `itx.sandbox`: agentSandboxPath maps the agent's own path under
    // the domain prefix, and agentPathForSandbox inverts it (that inverse is
    // what fans lifecycle events out to the agent journal).
    expect(agentSandboxPath("/agents/demo")).toBe("/sandboxes/cloudflare/agents/demo");
    expect(agentPathForSandbox("/sandboxes/cloudflare/agents/demo")).toBe("/agents/demo");
    // Slack thread agents nest a dotted timestamp — must stay in lockstep.
    expect(agentSandboxPath("/agents/slack/C123/ts-1738000000.123456")).toBe(
      "/sandboxes/cloudflare/agents/slack/C123/ts-1738000000.123456",
    );
    // Standalone sandboxes have no owning agent.
    expect(agentPathForSandbox("/sandboxes/cloudflare/whatever")).toBe(null);
  });

  test("accepts any path the agent Durable Object can tolerate (codec-safe)", () => {
    // `@` survives URL parsing, so an agent can live here and its DO works —
    // the sandbox must not be stricter than the path it mirrors.
    expect(agentSandboxPath("/agents/foo@bar")).toBe("/sandboxes/cloudflare/agents/foo@bar");
  });

  test("rejects paths outside /sandboxes/", () => {
    // The domain prefix is the identity convention (like /secrets, /repos):
    // a bare agent path is the AGENT, not its sandbox.
    expect(() => normalizeSandboxPath("/agents/demo")).toThrow(/live under \/sandboxes/);
    expect(() => normalizeSandboxPath("/sandboxes")).toThrow(/live under \/sandboxes/);
  });

  test("adds the leading slash", () => {
    expect(normalizeSandboxPath("sandboxes/cloudflare/deeply/nested/path")).toBe(
      "/sandboxes/cloudflare/deeply/nested/path",
    );
  });

  test("rejects the root path", () => {
    expect(() => normalizeSandboxPath("/")).toThrow(/live under \/sandboxes/);
    expect(() => normalizeSandboxPath("")).toThrow(/live under \/sandboxes/);
  });

  test("rejects paths that do not round-trip through the name codec", () => {
    // A space becomes %20 and `/x/../y` collapses to `/y`: two spellings would
    // otherwise mint two Durable Objects for one canonical identity.
    expect(() => normalizeSandboxPath("/sandboxes/foo/../bar")).toThrow(
      /round-trip|stable Durable Object|live under/,
    );
    expect(() => normalizeSandboxPath("/sandboxes/foo bar")).toThrow(
      /round-trip|stable Durable Object/,
    );
  });
});
