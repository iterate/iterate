import { expect, onTestFinished, test, vi } from "vitest";
import { agentsVersion, installAgents, upgradeAgents } from "./install.ts";

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
  {
    name: "a config pinning the package among others answers its pin",
    packageJson: manifest({ dependencies: { hono: "^4", [name]: newer } }),
    version: newer,
  },
  { name: "a package.json that is not JSON pins none", packageJson: "{", version: undefined },
])("the agents version: $name", async ({ packageJson, version }) => {
  const { project } = configProject({ "package.json": packageJson });
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

test.for([
  { name: "published, it answers the commit", outcome: UPDATED, error: undefined },
  {
    name: "refused, main moving on meanwhile included, it throws why and the person upgrades again",
    outcome: FAILED,
    error: "main moved on to commit-2 before this commit was published",
  },
])(
  "an upgrade commits the pin on the tip it read, keeping the rest of package.json, and waits once for that commit's outcome: $name",
  async ({ outcome, error }) => {
    const config = configProject({
      "package.json": manifest({ private: true, dependencies: { [name]: older, hono: "^4" } }),
    });
    const upgrade = upgradeAgents(config.project, newer);
    await vi.waitFor(() => expect(config.commits).toHaveLength(1));
    config.land(outcome, "commit-1", { error });
    if (error) await expect(upgrade).rejects.toThrow(`The upgrade was not published: ${error}`);
    else expect(await upgrade).toBe("commit-1");
    expect(config).toMatchObject({
      commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
      trees: {
        "commit-1": {
          "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
        },
      },
    });
    expect(config.project.waitForEvent).toHaveBeenCalledExactlyOnceWith({
      type: [UPDATED, FAILED],
      payload: { commitOid: "commit-1" },
      afterOffset: 0,
      timeoutMs: expect.any(Number),
    });
    // the deadline is read a moment before the wait starts, so the clock may tick in between
    const [[wait]] = vi.mocked(config.project.waitForEvent).mock.calls;
    expect(wait.timeoutMs).toBeGreaterThan(119_900);
  },
);

test("the platform's give-up for now (`unavailable`) is no outcome: an upgrade waits past it for the publication the platform still owes", async () => {
  const config = configProject({ "package.json": manifest({ dependencies: { [name]: older } }) });
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  const upgrade = upgradeAgents(config.project, newer);
  await vi.waitFor(() => expect(config.commits).toHaveLength(1));
  // a minute later the give-up lands: the wait after it has what is left of the two minutes
  vi.setSystemTime(Date.now() + 60_000);
  config.land(FAILED, "commit-1", { error: "esm.sh answered 503", unavailable: true });
  config.land(UPDATED, "commit-1");
  expect(await upgrade).toBe("commit-1");
  const [, [second]] = vi.mocked(config.project.waitForEvent).mock.calls;
  expect(second?.timeoutMs).toBeLessThanOrEqual(60_000);
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
 *  `publishedCommit`; each commit lands on the tip. A publication outcome on `/` lands by hand
 *  (`land`), as the stream's filter answers it, and a published one moves the commit the project
 *  runs, as the project's reduce does. */
function configProject(initial: Record<string, string>, publishedCommit: string | null = "seed") {
  const trees: Record<string, Record<string, string>> = { seed: { ...initial } };
  const commits: { message: string; parent?: string | null }[] = [];
  const log: { type: string; offset: number; payload: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  let tip = "seed";
  const repo = {
    tip: async () => tip,
    readFile: async (path: string, options?: { commitOid?: string }) =>
      trees[options?.commitOid || tip]?.[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content?: string }[];
      parent?: string | null;
    }) => {
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
    // the stream's filter: one of the types, after the offset, carrying each payload field it names
    waitForEvent: vi.fn(
      async (filter: {
        type?: string | string[];
        afterOffset?: number;
        timeoutMs?: number;
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
    land: (type: string, commitOid: string, payload: Record<string, unknown> = {}) => {
      log.push({ type, offset: 1 + log.length, payload: { commitOid, ...payload } });
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
