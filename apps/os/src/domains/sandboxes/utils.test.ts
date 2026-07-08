import { describe, expect, test } from "vitest";
import {
  assertSandboxPath,
  githubTokenEnvForConnections,
  sandboxInstanceTypeForPath,
  sandboxPathFor,
} from "./utils.ts";

describe("sandboxPathFor / sandboxInstanceTypeForPath", () => {
  test("the instance type is the path's second segment — create's path mint and get's routing agree", () => {
    expect(sandboxPathFor("basic", "my-pet")).toBe("/sandboxes/basic/my-pet");
    expect(sandboxInstanceTypeForPath("/sandboxes/basic/my-pet")).toBe("basic");
    // Nested names are fine — the path is the identity, the type the router.
    expect(sandboxPathFor("standard-2", "team/scrapey")).toBe("/sandboxes/standard-2/team/scrapey");
    expect(sandboxInstanceTypeForPath("/sandboxes/standard-2/team/scrapey")).toBe("standard-2");
  });

  test("rejects paths whose segment is not a Cloudflare instance type", () => {
    // Includes every pre-pet `/sandboxes/cloudflare/...` path — those sandboxes
    // are gone with their container class; pets carry their type in the path.
    expect(() => sandboxInstanceTypeForPath("/sandboxes/cloudflare/whatever")).toThrow(
      /instance type/,
    );
    expect(() => sandboxInstanceTypeForPath("/sandboxes/huge/my-pet")).toThrow(/instance type/);
  });
});

describe("assertSandboxPath", () => {
  test("accepts /sandboxes/ paths verbatim, arbitrarily nested", () => {
    expect(assertSandboxPath("/sandboxes/basic/whatever")).toBe("/sandboxes/basic/whatever");
    expect(assertSandboxPath("/sandboxes/lite/bla/bla")).toBe("/sandboxes/lite/bla/bla");
  });

  test("validates, never rewrites — paths are exact strings", () => {
    // No normalization: a missing leading slash is an error, not a repair.
    expect(() => assertSandboxPath("sandboxes/basic/deeply/nested")).toThrow(
      /start with \/sandboxes/,
    );
  });

  test("rejects paths outside /sandboxes/", () => {
    // The domain prefix is the identity convention (like /secrets, /repos).
    expect(() => assertSandboxPath("/agents/demo")).toThrow(/start with \/sandboxes/);
    expect(() => assertSandboxPath("/sandboxes")).toThrow(/start with \/sandboxes/);
    expect(() => assertSandboxPath("/")).toThrow(/start with \/sandboxes/);
    expect(() => assertSandboxPath("")).toThrow(/start with \/sandboxes/);
  });

  test("rejects paths the name codec would rewrite", () => {
    // A space becomes %20 and `/x/../y` collapses to `/y`: two spellings would
    // otherwise mint two Durable Objects for one identity.
    expect(() => assertSandboxPath("/sandboxes/foo/../bar")).toThrow(/rewrite/);
    expect(() => assertSandboxPath("/sandboxes/foo bar")).toThrow(/rewrite/);
  });
});

describe("githubTokenEnvForConnections", () => {
  test("builds the connection secret's accessToken placeholder — never token bytes", () => {
    expect(
      githubTokenEnvForConnections([{ connection: "install-42", integration: "github" }]),
    ).toBe('getSecret({ path: "/secrets/integrations/github/install-42", field: "accessToken" })');
  });

  test("null when the project has no GitHub connection (other integrations don't count)", () => {
    expect(githubTokenEnvForConnections([])).toBe(null);
    expect(githubTokenEnvForConnections([{ connection: "acme", integration: "slack" }])).toBe(null);
  });

  test("several connections: the lexicographically first connection name wins, deterministically", () => {
    const placeholder = githubTokenEnvForConnections([
      { connection: "install-9", integration: "github" },
      { connection: "acme", integration: "slack" },
      { connection: "install-10", integration: "github" },
    ]);
    expect(placeholder).toContain("/secrets/integrations/github/install-10");
  });
});
