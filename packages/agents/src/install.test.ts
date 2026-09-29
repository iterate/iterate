import { expect, onTestFinished, test, vi } from "vitest";
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
const UPDATED = "events.iterate.com/project/worker-updated";
const FAILED = "events.iterate.com/project/worker-update-failed";

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

test("the agents version is the build the project runs: the published commit's pin, never one the tip pins while its publication is owed or after it was refused", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.commits).toHaveLength(1));
  expect(await agentsVersion(config.project)).toBe(older);
  config.land(FAILED, "commit-1", { error: "refused" });
  await expect(upgrade).rejects.toThrow("refused");
  expect(await agentsVersion(config.project)).toBe(older);
  config.land(UPDATED, "commit-1");
  expect(await agentsVersion(config.project)).toBe(newer);
  const unpublished = configProject({}, null);
  expect(await agentsVersion(unpublished.project)).toBeUndefined();
});

test("an upgrade commits the new pin on the tip it read, keeps the rest of package.json, and answers once its commit is published", async () => {
  const config = configProject({
    "package.json": manifest({ private: true, dependencies: { [name]: older, hono: "^4" } }),
  });
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.commits).toHaveLength(1));
  // another commit's publication lands first: not this one's
  config.land(UPDATED, "elsewhere");
  config.land(UPDATED, "commit-1");
  expect(await upgrade).toBe("commit-1");
  expect(config).toMatchObject({
    commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
    trees: {
      "commit-1": {
        "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
      },
    },
  });
  // it waited for its own commit's outcome, from the head it read before committing
  expect(config.project.waitForEvent.mock.calls[0]![0]).toMatchObject({
    afterOffset: 7,
    payload: { commitOid: "commit-1" },
  });
});

test("an upgrade waits for its outcome in 5 s slices, each a fresh call: a slice that times out is asked again from where it waited", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  config.project.waitForEvent.mockRejectedValueOnce(codedError("WAIT_TIMEOUT", "no event yet"));
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.project.waitForEvent).toHaveBeenCalledTimes(2));
  config.land(UPDATED, "commit-1");
  expect(await upgrade).toBe("commit-1");
  expect(config.project.waitForEvent.mock.calls.map(([filter]) => filter)).toEqual([
    expect.objectContaining({ afterOffset: 7, timeoutMs: 5_000 }),
    expect.objectContaining({ afterOffset: 7, timeoutMs: 5_000 }),
  ]);
});

test.for([
  { name: "is published", outcome: UPDATED, answer: "commit-2" },
  { name: "is refused, saying why", outcome: FAILED, answer: undefined },
])(
  "an upgrade whose commit main moved on from waits for main's head, which holds its pin: one that $name",
  async ({ outcome, answer }) => {
    const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
    const upgrade = upgradeAgents(config.project, newer);
    await vi.waitFor(() => expect(config.commits).toHaveLength(1));
    await config.commitWebsite();
    config.land(FAILED, "commit-1", {
      error: "main moved on to commit-2 before this commit was published",
    });
    config.land(outcome, "commit-2", { error: "worker.ts does not construct" });
    if (answer) expect(await upgrade).toBe(answer);
    else await expect(upgrade).rejects.toThrow("worker.ts does not construct");
  },
);

test("an upgrade has one deadline: a main that keeps moving on ends it in two minutes, saying the old build still runs", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  config.project.waitForEvent.mockImplementation(async ({ payload, afterOffset = 0 }) => {
    vi.setSystemTime(Date.now() + 30_000);
    await config.commitWebsite();
    return { type: FAILED, offset: afterOffset + 1, payload: { ...payload, error: "moved on" } };
  });
  await expect(upgradeAgents(config.project, newer)).rejects.toThrow(
    "within two minutes: the project still runs the old build",
  );
  expect(config.project.waitForEvent).toHaveBeenCalledTimes(4);
});

test.for([
  { name: "published answers it at once", land: UPDATED, answer: "seed" },
  { name: "refused says why again", land: FAILED, answer: undefined },
  { name: "still owed waits for its outcome", land: undefined, answer: "seed" },
])(
  "an upgrade to the build the tip already pins commits nothing, and a tip that is $name",
  async ({ land, answer }) => {
    const config = configProject({ "package.json": manifest({ dependencies: { [name]: newer } }) });
    if (land) config.land(land, "seed", { error: "agents.ts does not resolve" });
    const upgrade = upgradeAgents(config.project, newer);
    if (!land) {
      await vi.waitFor(() => expect(config.project.waitForEvent).toHaveBeenCalledOnce());
      config.land(UPDATED, "seed");
    }
    if (answer) expect(await upgrade).toBe(answer);
    else await expect(upgrade).rejects.toThrow("agents.ts does not resolve");
    expect(config).toMatchObject({ commits: [] });
    // its outcome is found in the root's history
    expect(config.project.waitForEvent.mock.calls[0]![0]).toMatchObject({
      afterOffset: 0,
      payload: { commitOid: "seed" },
    });
  },
);

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
  config.land(FAILED, "commit-1", {
    error: "worker.ts's default export is not an IterateConfigEntrypoint",
  });
  await expect(upgrade).rejects.toThrow(
    "package.json pins the new build (config commit commit-), but its publication failed, so the project still runs the old one: worker.ts's default export is not an IterateConfigEntrypoint",
  );
  expect(config.trees["commit-1"]!["package.json"]).toContain(newer);
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

/** A project root over an in-memory config repo whose `seed` holds `initial` and which runs
 *  `publishedCommit`; its commits land as the platform's do (`parent` must be the tip). A
 *  publication outcome on `/` lands by hand (`land`), after a head at 7, as the stream's filter
 *  answers it, and a published one moves the commit the project runs, as the project's reduce does. */
function configProject(initial: Record<string, string>, publishedCommit: string | null = "seed") {
  const trees: Record<string, Record<string, string>> = { seed: { ...initial } };
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
    readFile: async (path: string, options?: { commitOid?: string }) =>
      trees[options?.commitOid || tip]?.[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content?: string }[];
      parent?: string | null;
    }) => {
      if (input.parent !== tip)
        throw new Error(
          `repo /repos/config: the commit was refused: main is at ${tip}, not at the parent it names (${input.parent})`,
        );
      const files = { ...trees[tip] };
      for (const change of input.changes) files[change.path] = change.content!;
      commits.push({ message: input.message, parent: input.parent });
      tip = `commit-${commits.length}`;
      trees[tip] = files;
      return { commitOid: tip, changedPaths: input.changes.map((change) => change.path) };
    },
  };
  const project = {
    repos: { get: () => repo },
    facets: { get: () => ({ snapshot: async () => ({ state: { publishedCommit } }) }) },
    readEvents: vi.fn(async () => ({ events: [], scannedThroughOffset: 7, atHead: true })),
    // the stream's filter: one of the types, after the offset, carrying each payload field it names
    waitForEvent: vi.fn(
      async (filter: {
        type?: string | string[];
        afterOffset?: number;
        payload?: Record<string, unknown>;
      }) => {
        for (;;) {
          const next = log.find(
            (event) =>
              [filter.type].flat().includes(event.type) &&
              event.offset > (filter.afterOffset ?? 0) &&
              Object.entries(filter.payload || {}).every(
                ([field, value]) => event.payload[field] === value,
              ),
          );
          if (next) return next;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    ),
  };
  return {
    trees,
    commits,
    moveMainAfterRead: () => void (movedAfterRead = true),
    /** Someone else's commit on main's head: the website changes. */
    commitWebsite: () =>
      repo.commitFiles({
        message: "website",
        parent: tip,
        changes: [{ path: "worker.ts", content: `// ${commits.length}` }],
      }),
    land: (type: string, commitOid: string, payload: Record<string, unknown> = {}) => {
      log.push({ type, offset: 8 + log.length, payload: { commitOid, ...payload } });
      if (type === UPDATED) publishedCommit = commitOid;
      for (const wake of waiters.splice(0)) wake();
    },
    // The fake implements only the calls an upgrade and the version make; typed once as what they
    // take.
    project: project as typeof project &
      Parameters<typeof upgradeAgents>[0] &
      Parameters<typeof agentsVersion>[0],
  };
}

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}
