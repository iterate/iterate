import { expect, test, vi } from "vitest";
import { aiLinterFolder, installAiLinter } from "./install.ts";

const version = "https://pkg.pr.new/iterate/iterate/@iterate-com/ai-linter@abc1234";

test("the linter's folder names its main module in package.json", () => {
  const folder = aiLinterFolder(version);
  expect(JSON.parse(folder["package.json"]!)).toEqual({
    main: "index.ts",
    dependencies: { "@iterate-com/ai-linter": version },
  });
  expect(folder["index.ts"]).toContain("AiLinterDurableObject");
});

test("the linter mounts on the connection to the repository's owner, lent the root's egress and model, with its choices", async () => {
  const root = project({ connections: ["c1"] });
  expect(await installAiLinter(root, aiLinterFolder(version), { repository: "Acme/app" })).toEqual({
    repository: "Acme/app",
    connection: "c1",
  });
  const connection = root.contexts["/integrations/github/c1"]!;
  expect(connection).toMatchObject({
    appended: [
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.fetch", target: "itx.builtins.cd('/').fetch" },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.ai", target: "itx.builtins.cd('/').ai" },
      },
      { type: "ai-linter/installed", payload: { repository: "Acme/app" } },
    ],
  });
  expect(connection.processors.enable).toHaveBeenCalledWith("ai-linter", {
    source: aiLinterFolder(version),
    className: "AiLinterDurableObject",
    consumes: [
      "events.iterate.com/github/webhook-received",
      "ai-linter/installed",
      "ai-linter/linted",
    ],
  });
});

test("a rules folder, a model and a connection named by the install; rows it has already are not written again", async () => {
  const root = project({
    connections: ["c1", "c2"],
    rules: { "itx.fetch": "itx.builtins.cd('/').fetch" },
  });
  await installAiLinter(root, aiLinterFolder(version), {
    repository: "acme/app",
    rules: "lint/rules",
    model: "openai/gpt-7",
    connection: "c2",
  });
  expect(root.contexts["/integrations/github/c2"]!).toMatchObject({
    appended: [
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.ai", target: "itx.builtins.cd('/').ai" },
      },
      {
        type: "ai-linter/installed",
        payload: { repository: "acme/app", rules: "lint/rules", model: "openai/gpt-7" },
      },
    ],
  });
});

test.for([
  [
    "a repository that is not owner/name",
    "acme",
    {},
    /acme is not a GitHub repository's owner\/name/,
  ],
  [
    "no connection to the owner",
    "acme/app",
    { connections: [] },
    /expected one GitHub connection to acme, found 0/,
  ],
  [
    "two connections to the owner",
    "acme/app",
    { connections: ["c1", "c2"] },
    /found 2: name one with \{ connection \}/,
  ],
] as const)("%s is refused, and nothing is installed", async ([, repository, input, error]) => {
  const root = project(input);
  await expect(installAiLinter(root, aiLinterFolder(version), { repository })).rejects.toThrow(
    error,
  );
  expect(Object.keys(root.contexts)).toEqual([]);
});

/** A project root as installing calls it: its GitHub connections to `acme` (`c1` by default), the
 *  rows the connections' logs already have, and each context `cd` reaches, recording what is
 *  appended and enabled. */
function project(input: { connections?: readonly string[]; rules?: Record<string, string> }) {
  const contexts: Record<string, ReturnType<typeof context>> = {};
  const integrations = Object.fromEntries(
    (input.connections || ["c1"]).map((connection) => [
      `/integrations/github/${connection}`,
      { provider: "github", connection, account: "acme" },
    ]),
  );
  const root = {
    contexts,
    whoami: vi.fn().mockResolvedValue({ path: "/" }),
    cd: (path: string) => (contexts[path] ??= context(input.rules || {})),
    facets: { get: () => ({ snapshot: async () => ({ state: { integrations } }) }) },
  };
  // The fake implements only the calls installing makes; typed once as what installAiLinter takes,
  // it keeps its records for the assertions.
  return root as typeof root & Parameters<typeof installAiLinter>[0];
}

function context(rules: Record<string, string>) {
  const appended: unknown[] = [];
  return {
    appended,
    append: vi.fn(async (...events: unknown[]) => {
      appended.push(...events);
      return [];
    }),
    rewriteRules: {
      get: vi.fn(async (match: string) => (rules[match] ? { match, target: rules[match] } : null)),
    },
    processors: { enable: vi.fn().mockResolvedValue({ name: "ai-linter" }) },
  };
}
