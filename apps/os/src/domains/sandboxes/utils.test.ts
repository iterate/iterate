import { describe, expect, test } from "vitest";
import { ITERATE_GITHUB_BOT_COMMIT_AUTHOR } from "../integrations/utils.ts";
import {
  assertSandboxPath,
  githubTokenEnvForConnections,
  sandboxPathFor,
  SANDBOX_GIT_CONFIG_SHELL,
} from "./utils.ts";

describe("sandboxPathFor", () => {
  test("a name mints /sandboxes/<name> — flat, no intermediate folders", () => {
    expect(sandboxPathFor("my-pet")).toBe("/sandboxes/my-pet");
  });

  test("rejects multi-segment names — every extra segment would materialize an intermediate folder stream", () => {
    expect(() => sandboxPathFor("team/scrapey")).toThrow(/single-segment/);
    expect(() => sandboxPathFor("")).toThrow(/single-segment/);
  });
});

describe("assertSandboxPath", () => {
  test("accepts exactly /sandboxes/<name>, verbatim", () => {
    expect(assertSandboxPath("/sandboxes/whatever")).toBe("/sandboxes/whatever");
    expect(assertSandboxPath("/sandboxes/example-matrix")).toBe("/sandboxes/example-matrix");
  });

  test("validates, never rewrites — paths are exact strings", () => {
    // No normalization: a missing leading slash is an error, not a repair.
    expect(() => assertSandboxPath("sandboxes/whatever")).toThrow(/single-segment/);
  });

  test("rejects nested paths — including every pre-flat /sandboxes/<instanceType>/<name> path", () => {
    // The instance type is configuration (journaled on create-requested), not
    // a path segment: nesting would materialize folder streams like
    // /sandboxes/lite that are not sandboxes.
    expect(() => assertSandboxPath("/sandboxes/lite/bla")).toThrow(/single-segment/);
    expect(() => assertSandboxPath("/sandboxes/cloudflare/whatever")).toThrow(/single-segment/);
    expect(() => assertSandboxPath("/sandboxes/a/b/c")).toThrow(/single-segment/);
  });

  test("rejects paths outside /sandboxes/", () => {
    // The domain prefix is the identity convention (like /secrets, /repos).
    expect(() => assertSandboxPath("/agents/demo")).toThrow(/\/sandboxes\/<name>/);
    expect(() => assertSandboxPath("/sandboxes")).toThrow(/\/sandboxes\/<name>/);
    expect(() => assertSandboxPath("/")).toThrow(/\/sandboxes\/<name>/);
    expect(() => assertSandboxPath("")).toThrow(/\/sandboxes\/<name>/);
  });

  test("rejects paths the name codec would rewrite", () => {
    // A space becomes %20: two spellings would otherwise mint two Durable
    // Objects for one identity.
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

describe("SANDBOX_GIT_CONFIG_SHELL", () => {
  test("plants lowercase iterate identity so GitHub shows the app avatar", () => {
    expect(ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name).toBe("iterate");
    expect(ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name).toBe(
      ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name.toLowerCase(),
    );
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain(
      `user.name '${ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name}'`,
    );
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain(
      `user.email '${ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email}'`,
    );
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain("users.noreply.github.com");
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain("iterate[bot]");
  });

  test("configures git extraheader as Basic x-access-token + base64 of GH_TOKEN placeholder", () => {
    // GitHub git smart-HTTP rejects Bearer; Basic with username x-access-token
    // is the documented install-token shape. The shell base64-encodes so the
    // placeholder still expands from $GH_TOKEN inside the container.
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain('http."https://github.com/".extraheader');
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain("AUTHORIZATION: Basic");
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain("x-access-token:${GH_TOKEN}");
    expect(SANDBOX_GIT_CONFIG_SHELL).toContain("base64");
    expect(SANDBOX_GIT_CONFIG_SHELL).not.toContain("Bearer");
  });
});
