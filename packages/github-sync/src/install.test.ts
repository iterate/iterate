import { expect, test, vi } from "vitest";
import { githubSyncFolder, installGithubSync } from "./install.ts";

const version = "https://pkg.pr.new/iterate/iterate/@iterate-com/github-sync@abc1234";
const origin =
  'https://x-access-token:getSecret("/secrets/github-c1", { field: "accessToken" })@github.com/Acme/config.git';

test("the sync's folder names its main module in package.json", () => {
  const folder = githubSyncFolder(version);
  expect(JSON.parse(folder["package.json"]!)).toEqual({
    main: "index.ts",
    dependencies: { "@iterate-com/github-sync": version },
  });
  expect(folder["index.ts"]).toContain("GithubSyncDurableObject");
});

test("the sync mounts on the connection to the origin's owner and on the root, each with its marker", async () => {
  const root = project({ origin });
  expect(await installGithubSync(root, githubSyncFolder(version))).toEqual({
    repo: "/repos/config",
    repository: "Acme/config",
    connection: "c1",
  });
  const connection = root.contexts["/integrations/github/c1"]!;
  expect(connection).toMatchObject({
    appended: [
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.repos", target: "itx.builtins.cd('/').repos" },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.fetch", target: "itx.builtins.cd('/').fetch" },
      },
      { type: "github-sync/installed", payload: { repo: "/repos/config" } },
    ],
  });
  expect(connection.processors.enable).toHaveBeenCalledWith("github-sync", {
    source: githubSyncFolder(version),
    className: "GithubSyncDurableObject",
    consumes: ["events.iterate.com/github/webhook-received", "github-sync/installed"],
  });
  expect(root.processors.enable).toHaveBeenCalledWith("github-sync", {
    source: githubSyncFolder(version),
    className: "GithubSyncDurableObject",
    consumes: ["events.iterate.com/repo/commit-completed", "github-sync/installed"],
  });
  expect(root).toMatchObject({
    appended: [{ type: "github-sync/installed", payload: { repo: "/repos/config" } }],
  });
});

test("another repo, and a connection named by the install", async () => {
  const root = project({ origin });
  await installGithubSync(root, githubSyncFolder(version), {
    repo: "/repos/site",
    connection: "c9",
  });
  expect(root).toMatchObject({ originsRead: ["/repos/site"] });
  expect(root.contexts["/integrations/github/c9"]!.appended.at(-1)).toEqual({
    type: "github-sync/installed",
    payload: { repo: "/repos/site" },
  });
});

test.for([
  ["a repo with no origin", { origin: null }, /has no GitHub origin: link it/],
  [
    "an origin on another host",
    { origin: "https://gitlab.com/acme/config.git" },
    /has no GitHub origin/,
  ],
  [
    "no connection to the owner",
    { origin, connections: [] },
    /expected one GitHub connection to Acme, found 0/,
  ],
  [
    "two connections to the owner",
    { origin, connections: ["c1", "c2"] },
    /expected one GitHub connection to Acme, found 2: name one with \{ connection \}/,
  ],
] as const)("%s is refused, and nothing is installed", async ([, input, error]) => {
  const root = project(input);
  await expect(installGithubSync(root, githubSyncFolder(version))).rejects.toThrow(error);
  expect(root.processors.enable).not.toHaveBeenCalled();
  expect(Object.keys(root.contexts)).toEqual([]);
});

/** A project root as installing calls it: its repo's origin, its GitHub connections (to `acme` by
 *  default one, `c1`), and each context `cd` reaches, recording what is appended and enabled. */
function project(input: { origin: string | null; connections?: readonly string[] }) {
  const contexts: Record<string, ReturnType<typeof context>> = {};
  const originsRead: string[] = [];
  const integrations = Object.fromEntries(
    (input.connections || ["c1"]).map((connection) => [
      `/integrations/github/${connection}`,
      { provider: "github", connection, account: "acme" },
    ]),
  );
  const root = {
    ...context(),
    contexts,
    originsRead,
    whoami: vi.fn().mockResolvedValue({ path: "/" }),
    cd: (path: string) => (contexts[path] ??= context()),
    facets: { get: () => ({ snapshot: async () => ({ state: { integrations } }) }) },
    repos: {
      get: (path: string) => ({
        origin: async () => {
          originsRead.push(path);
          return input.origin;
        },
      }),
    },
  };
  // The fake implements only the calls installing makes; typed once as what installGithubSync
  // takes, it keeps its records for the assertions.
  return root as typeof root & Parameters<typeof installGithubSync>[0];
}

function context() {
  const appended: unknown[] = [];
  return {
    appended,
    append: vi.fn(async (...events: unknown[]) => {
      appended.push(...events);
      return [];
    }),
    rewriteRules: { get: vi.fn().mockResolvedValue(null) },
    processors: { enable: vi.fn().mockResolvedValue({ name: "github-sync" }) },
  };
}
