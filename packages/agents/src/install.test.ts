import { expect, test, vi } from "vitest";
import { codedError } from "iterate/lib";
import { agentsFacetSpec, agentsVersion, installAgents, upgradeAgents } from "./install.ts";

test.for(["AgentCollectionDurableObject", "AgentDurableObject"] as const)(
  "%s is named in agents.ts of the published config, with no cache key",
  (className) => {
    expect(agentsFacetSpec(className)).toStrictEqual(published(className));
  },
);

test("installAgents enables the catalog processor on the root, then writes the itx.agents rule to it", async () => {
  const root = fakeRoot();
  await installAgents(root);
  expect(root).toMatchObject({
    calls: [
      [
        "processors.enable",
        "agents",
        {
          ...published("AgentCollectionDurableObject"),
          consumes: ["events.iterate.com/agent/created", "events.iterate.com/agent/deleted"],
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: {
            match: "itx.agents",
            target: ["itx", "facets", ["get", "agents", published("AgentCollectionDurableObject")]],
            description: expect.stringContaining("create(path)"),
          },
        },
      ],
    ],
  });
});

const name = "@iterate-com/agents";
const older = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@abc1234";
const newer = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@def5678";

test.for([
  [
    "a config pinning the package answers its pin",
    manifest({ dependencies: { [name]: newer } }),
    newer,
  ],
  ["a package.json that is not JSON pins none", "{", undefined],
  ["another package's pin is not this one", manifest({ dependencies: { hono: "^4" } }), undefined],
  ["a config without a package.json pins none", null, undefined],
] as const)("the agents version: %s", async ([, packageJson, version]) => {
  const { project } = configProject(packageJson ? { "package.json": packageJson } : {});
  expect(await agentsVersion(project)).toBe(version);
});

test("an upgrade commits the new pin on the tip it read, keeps the rest of package.json, and answers once its commit is published", async () => {
  const config = configProject({
    "package.json": manifest({ private: true, dependencies: { [name]: older, hono: "^4" } }),
  });
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.commits).toHaveLength(1));
  // another commit's publication lands first: not this one's
  config.publish("events.iterate.com/project/worker-updated", "elsewhere");
  config.publish("events.iterate.com/project/worker-updated", "commit-1");
  expect(await upgrade).toBe("commit-1");
  expect(config).toMatchObject({
    commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
    files: {
      "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
    },
  });
  // it waited for its own commit's outcome, from the head it read before committing
  expect(config.project.waitForEvent.mock.calls[0]![0]).toMatchObject({
    afterOffset: 7,
    payload: { commitOid: "commit-1" },
  });
});

test("an upgrade waits for its publication in 5 s slices, each a fresh call: a slice that times out is asked again from where it waited", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  config.project.waitForEvent.mockRejectedValueOnce(codedError("WAIT_TIMEOUT", "no event yet"));
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.project.waitForEvent).toHaveBeenCalledTimes(2));
  config.publish("events.iterate.com/project/worker-updated", "commit-1");
  expect(await upgrade).toBe("commit-1");
  expect(config.project.waitForEvent.mock.calls.map(([filter]) => filter)).toEqual([
    expect.objectContaining({ afterOffset: 7, timeoutMs: 5_000 }),
    expect.objectContaining({ afterOffset: 7, timeoutMs: 5_000 }),
  ]);
});

test("a config already at the build commits nothing and waits for no publication", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: newer } }) });
  expect(await upgradeAgents(config.project, newer)).toBe("seed");
  expect(config).toMatchObject({ commits: [] });
  expect(config.project.waitForEvent).not.toHaveBeenCalled();
});

test("main moving after the read refuses the commit, and nothing is waited for", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  config.moveMainAfterRead();
  await expect(upgradeAgents(config.project, newer)).rejects.toThrow(
    "the commit was refused: main is at elsewhere, not at the parent it names (seed)",
  );
  expect(config.project.waitForEvent).not.toHaveBeenCalled();
});

test("a publication the platform refuses says the new build is pinned and why it is not running", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.commits).toHaveLength(1));
  config.publish("events.iterate.com/project/worker-update-failed", "commit-1", {
    error: "agents.ts no longer exports AgentDurableObject",
  });
  await expect(upgrade).rejects.toThrow(
    "package.json pins the new build (config commit commit-), but its publication failed, so the project still runs the old one: agents.ts no longer exports AgentDurableObject",
  );
  expect(config.files["package.json"]).toContain(newer);
});

/** The facet spec every row and rule of the app names: a class of the config repo's `agents.ts`,
 *  in the project's published config (the facet restarts by that module's bundle, not a key). */
function published(className: string) {
  return { className, mainModule: "agents.ts", source: ["itx", ["cd", "/"], "config"] };
}

/** A project root that records the calls installing makes. */
function fakeRoot() {
  const calls: unknown[][] = [];
  return {
    calls,
    processors: {
      enable: vi.fn(async (name: string, spec?: object) => {
        calls.push(["processors.enable", name, spec]);
        return { name };
      }),
    },
    append: vi.fn(async (...events: object[]) => {
      calls.push(["append", ...events]);
      return [];
    }),
  };
}

/** A project root over an in-memory config repo whose commits land as the platform's do (`parent`
 *  must be the tip), and a `/` whose publications a row lands by hand (`publish`), after a head at 7. */
function configProject(initial: Record<string, string>) {
  const files = { ...initial };
  const commits: { message: string; parent?: string | null }[] = [];
  const log: { type: string; offset: number; payload: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  let tip = "seed";
  let movedAfterRead = false;
  const repo = {
    tip: async () => {
      const read = tip;
      if (movedAfterRead) tip = "elsewhere";
      return read;
    },
    readFile: async (path: string) => files[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content?: string }[];
      parent?: string | null;
    }) => {
      if (input.parent !== tip)
        throw new Error(
          `repo /repos/config: the commit was refused: main is at ${tip}, not at the parent it names (${input.parent})`,
        );
      for (const change of input.changes) files[change.path] = change.content!;
      commits.push({ message: input.message, parent: input.parent });
      tip = `commit-${commits.length}`;
      return { commitOid: tip, changedPaths: input.changes.map((change) => change.path) };
    },
  };
  const project = {
    repos: { get: () => repo },
    readEvents: vi.fn(async () => ({ events: [], scannedThroughOffset: 7, atHead: true })),
    // the stream's filter: after the offset, and carrying each payload field it names
    waitForEvent: vi.fn(
      async ({ afterOffset = 0, payload = {} }: { afterOffset?: number; payload?: object }) => {
        for (;;) {
          const next = log.find(
            (event) =>
              event.offset > afterOffset &&
              Object.entries(payload).every(([field, value]) => event.payload[field] === value),
          );
          if (next) return next;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    ),
  };
  return {
    files,
    commits,
    moveMainAfterRead: () => void (movedAfterRead = true),
    publish: (type: string, commitOid: string, payload: Record<string, unknown> = {}) => {
      log.push({ type, offset: 8 + log.length, payload: { commitOid, ...payload } });
      for (const wake of waiters.splice(0)) wake();
    },
    // The fake implements only the calls an upgrade makes; typed once as what upgradeAgents takes.
    project: project as typeof project & Parameters<typeof upgradeAgents>[0],
  };
}

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}
