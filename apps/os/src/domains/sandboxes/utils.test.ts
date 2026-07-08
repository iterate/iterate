import { describe, expect, test } from "vitest";
import {
  githubTokenEnvForConnections,
  normalizeSandboxPath,
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

describe("normalizeSandboxPath", () => {
  test("accepts /sandboxes/ paths, arbitrarily nested", () => {
    expect(normalizeSandboxPath("/sandboxes/basic/whatever")).toBe("/sandboxes/basic/whatever");
    expect(normalizeSandboxPath("/sandboxes/lite/bla/bla")).toBe("/sandboxes/lite/bla/bla");
  });

  test("rejects paths outside /sandboxes/", () => {
    // The domain prefix is the identity convention (like /secrets, /repos).
    expect(() => normalizeSandboxPath("/agents/demo")).toThrow(/live under \/sandboxes/);
    expect(() => normalizeSandboxPath("/sandboxes")).toThrow(/live under \/sandboxes/);
  });

  test("adds the leading slash", () => {
    expect(normalizeSandboxPath("sandboxes/basic/deeply/nested/path")).toBe(
      "/sandboxes/basic/deeply/nested/path",
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
