import { codedError } from "iterate/lib";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  ensureVoiceAgent,
  installVoice,
  upgradeVoice,
  voiceAgentFacetSpec,
  voiceVersion,
} from "./install.ts";

const name = "@iterate-com/voice";
const older = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@abc1234";
const newer = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@def5678";
const UPDATED = "events.iterate.com/project/worker-updated";
const FAILED = "events.iterate.com/project/worker-update-failed";
const RULE = "events.iterate.com/itx/rewrite-rule-configured";

test("installVoice stores the screen font and writes the itx.voice rule to voice.ts of the published config, with no cache key", async () => {
  const root = project();
  await installVoice(root);
  expect(root.kv.values["voice/screen-font.css"]).toContain("Iterate Pixel");
  expect(root.append.mock).toMatchObject({
    calls: [
      [
        {
          type: RULE,
          payload: {
            match: "itx.voice",
            target: ["itx", "workers", ["get", published]],
            description: expect.stringContaining("setupVoiceAgent"),
          },
        },
      ],
    ],
  });
});

test("each press's relay facet is voice.ts's VoiceAgentDurableObject of the published config, with no cache key", () => {
  expect(voiceAgentFacetSpec).toStrictEqual({ className: "VoiceAgentDurableObject", ...published });
});

test("a project whose config installed voice and that has a key is ready at once: nothing is stored or waited for", async () => {
  const root = project({ voice: true });
  expect(await ensureVoiceAgent(root, "unused")).toBe("ready");
  expect(root.secrets.set).not.toHaveBeenCalled();
  expect(root.waitForEvent).not.toHaveBeenCalled();
  expect(root.voice.health).toHaveBeenCalledOnce();
});

test("a key given to a project without one is stored, pinned to OpenAI, before the service is asked", async () => {
  const root = project({ voice: true, key: false });
  expect(await ensureVoiceAgent(root, " sk-test ")).toBe("ready");
  expect(root.secrets.set).toHaveBeenCalledWith("/secrets/openai", "sk-test", {
    urls: ["https://api.openai.com"],
  });
});

test("a project without an OpenAI key and none given is asked for one, and nothing is stored", async () => {
  const root = project({ voice: true, key: false });
  expect(await ensureVoiceAgent(root)).toBe("needs-openai-key");
  expect(root.secrets.set).not.toHaveBeenCalled();
  expect(root.voice.health).not.toHaveBeenCalled();
});

test("a project created a moment ago is waited for until its config repo's init case installs voice: its rule as the root stores it, past another rule and another commit's refusal", async () => {
  const root = project();
  root.land(RULE, { match: ["itx", "agents"], target: ["itx", "facets", ["get", "agents"]] });
  root.land(FAILED, { commitOid: "before-seed", error: "an older commit's refusal" });
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  expect(await ensureVoiceAgent(root)).toBe("ready");
  expect(root.waitForEvent.mock.calls.map(([filter]) => filter.afterOffset)).toEqual([0, 8, 9]);
  expect(root.voice.health).toHaveBeenCalledOnce();
});

test("a config whose commit that pins voice was refused is refused at once, saying why", async () => {
  const root = project();
  root.land(FAILED, { commitOid: "seed", error: "voice.ts imports ./missing.ts" });
  await expect(ensureVoiceAgent(root)).rejects.toThrow(
    "The project's config (commit seed) was not published, so it installs no voice: voice.ts imports ./missing.ts",
  );
});

test("a project whose config repo is not created yet is waited for, not refused", async () => {
  const root = project({ seeded: false });
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  expect(await ensureVoiceAgent(root)).toBe("ready");
});

test.for([
  {
    name: "a config that pins no @iterate-com/voice (the minimal template)",
    pin: false,
    answer: undefined,
    error:
      "This project's config repo does not install voice: its package.json lists no @iterate-com/voice",
  },
  {
    name: "voice does not arrive within a minute",
    pin: true,
    answer: () => Promise.reject(codedError("WAIT_TIMEOUT", "no matching event")),
    error: "Voice was not installed within a minute",
  },
  {
    name: "the project's creation failed",
    pin: true,
    answer: async () => ({
      type: "events.iterate.com/project/create-failed",
      offset: 2,
      payload: { error: "no template" },
    }),
    error: "The project's creation failed, so its config repo installs no voice: no template",
  },
])("$name: refused", async ({ pin, answer, error }) => {
  const root = project({ pin, key: false });
  if (answer) root.waitForEvent.mockImplementation(answer as never);
  await expect(ensureVoiceAgent(root, "a key")).rejects.toThrow(error);
  // a config that installs no voice is refused before anything is stored or waited for; one that
  // pins it keeps the key it was given for when voice arrives
  expect(root.secrets.set).toHaveBeenCalledTimes(pin ? 1 : 0);
  expect(root.waitForEvent).toHaveBeenCalledTimes(pin ? 1 : 0);
});

test("readiness has one deadline: rules that are not voice's, however many arrive, end in a refusal after a minute", async () => {
  const root = project();
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  root.waitForEvent.mockImplementation(async ({ afterOffset = 0 }) => {
    vi.setSystemTime(Date.now() + 10_000);
    return {
      type: RULE,
      offset: afterOffset + 1,
      payload: { match: ["itx", "x"], target: ["itx"] },
    };
  });
  await expect(ensureVoiceAgent(root)).rejects.toThrow("Voice was not installed within a minute");
  expect(root.waitForEvent).toHaveBeenCalledTimes(6);
});

test("a broken voice service is reported as it is: nothing replaces it", async () => {
  const root = project({ voice: true });
  root.voice.health.mockRejectedValue(new Error("No such module voice.ts"));
  await expect(ensureVoiceAgent(root)).rejects.toThrow("No such module voice.ts");
  expect(root.append).not.toHaveBeenCalled();
});

test.for([
  [
    "a config pinning the package answers its pin",
    manifest({ dependencies: { [name]: newer } }),
    newer,
  ],
  ["a package.json that is not JSON pins none", "{", undefined],
  ["another package's pin is not this one", manifest({ dependencies: { hono: "^4" } }), undefined],
  ["a config without a package.json pins none", null, undefined],
] as const)("the voice version: %s", async ([, packageJson, version]) => {
  const root = project();
  if (packageJson) root.trees.seed!["package.json"] = packageJson;
  else delete root.trees.seed!["package.json"];
  expect(await voiceVersion(root)).toBe(version);
});

test("the voice version is the build the project runs: the published commit's pin, never one the tip pins while its publication is owed or after it was refused", async () => {
  const root = project();
  const upgrade = upgradeVoice(root, newer);
  await vi.waitFor(() => expect(root.commits).toHaveLength(1));
  expect(await voiceVersion(root)).toBe(older);
  root.land(FAILED, { commitOid: "commit-1", error: "refused" });
  await expect(upgrade).rejects.toThrow("refused");
  expect(await voiceVersion(root)).toBe(older);
  root.land(UPDATED, { commitOid: "commit-1" });
  expect(await voiceVersion(root)).toBe(newer);
  expect(await voiceVersion(project({ published: null }))).toBeUndefined();
});

test("an upgrade commits the new pin on the tip it read, keeps the rest of package.json, and answers once its commit is published", async () => {
  const root = project();
  root.trees.seed!["package.json"] = manifest({
    private: true,
    dependencies: { [name]: older, hono: "^4" },
  });
  const upgrade = upgradeVoice(root, newer);
  await vi.waitFor(() => expect(root.commits).toHaveLength(1));
  // another commit's publication lands first: not this one's
  root.land(UPDATED, { commitOid: "elsewhere" });
  root.land(UPDATED, { commitOid: "commit-1" });
  expect(await upgrade).toBe("commit-1");
  expect(root).toMatchObject({
    commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
    trees: {
      "commit-1": {
        "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
      },
    },
  });
  // it waited for its own commit's outcome, from the head it read before committing
  expect(root.waitForEvent.mock.calls[0]![0]).toMatchObject({
    afterOffset: 7,
    payload: { commitOid: "commit-1" },
  });
});

test.for([
  { name: "is published", outcome: UPDATED, answer: "commit-2" },
  { name: "is refused, saying why", outcome: FAILED, answer: undefined },
])(
  "an upgrade whose commit main moved on from waits for main's head, which holds its pin: one that $name",
  async ({ outcome, answer }) => {
    const root = project();
    const upgrade = upgradeVoice(root, newer);
    await vi.waitFor(() => expect(root.commits).toHaveLength(1));
    await root.commitWebsite();
    root.land(FAILED, {
      commitOid: "commit-1",
      error: "main moved on to commit-2 before this commit was published",
    });
    root.land(outcome, { commitOid: "commit-2", error: "worker.ts does not construct" });
    if (answer) expect(await upgrade).toBe(answer);
    else await expect(upgrade).rejects.toThrow("worker.ts does not construct");
  },
);

test("an upgrade has one deadline: a main that keeps moving on ends it in two minutes, saying the old build still runs", async () => {
  const root = project();
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  root.waitForEvent.mockImplementation(async ({ payload, afterOffset = 0 }) => {
    vi.setSystemTime(Date.now() + 30_000);
    await root.commitWebsite();
    return { type: FAILED, offset: afterOffset + 1, payload: { ...payload, error: "moved on" } };
  });
  await expect(upgradeVoice(root, newer)).rejects.toThrow(
    "within two minutes: the project still runs the old build",
  );
  expect(root.waitForEvent).toHaveBeenCalledTimes(4);
});

test.for([
  { name: "published answers it at once", land: UPDATED, answer: "seed" },
  { name: "refused says why again", land: FAILED, answer: undefined },
  { name: "still owed waits for its outcome", land: undefined, answer: "seed" },
])(
  "an upgrade to the build the tip already pins commits nothing, and a tip that is $name",
  async ({ land, answer }) => {
    const root = project();
    root.trees.seed!["package.json"] = manifest({ dependencies: { [name]: newer } });
    if (land) root.land(land, { commitOid: "seed", error: "voice.ts does not resolve" });
    const upgrade = upgradeVoice(root, newer);
    if (!land) {
      await vi.waitFor(() => expect(root.waitForEvent).toHaveBeenCalledOnce());
      root.land(UPDATED, { commitOid: "seed" });
    }
    if (answer) expect(await upgrade).toBe(answer);
    else await expect(upgrade).rejects.toThrow("voice.ts does not resolve");
    expect(root).toMatchObject({ commits: [] });
    // its outcome is found in the root's history
    expect(root.waitForEvent.mock.calls[0]![0]).toMatchObject({
      afterOffset: 0,
      payload: { commitOid: "seed" },
    });
  },
);

test("main moving after the read refuses the commit, and nothing is waited for", async () => {
  const root = project();
  root.moveMainAfterRead();
  await expect(upgradeVoice(root, newer)).rejects.toThrow(
    "the commit was refused: main is at elsewhere, not at the parent it names (seed)",
  );
  expect(root.waitForEvent).not.toHaveBeenCalled();
});

test("a publication the platform refuses says the new build is pinned and why it is not running", async () => {
  const root = project();
  const upgrade = upgradeVoice(root, newer);
  await vi.waitFor(() => expect(root.commits).toHaveLength(1));
  root.land(FAILED, {
    commitOid: "commit-1",
    error: "worker.ts's default export is not an IterateConfigEntrypoint",
  });
  await expect(upgrade).rejects.toThrow(
    "package.json pins the new build (config commit commit-), but its publication failed, so the project still runs the old one: worker.ts's default export is not an IterateConfigEntrypoint",
  );
  expect(root.trees["commit-1"]!["package.json"]).toContain(newer);
});

/** Where every rule and row of voice names its code: `voice.ts` of the project's published config
 *  (it restarts by that module's bundle, not a key). */
const published = { mainModule: "voice.ts", source: ["itx", ["cd", "/"], "config"] };

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** A project root over an in-memory config repo whose `seed` pins `older` (none unless `pin`), and
 *  which runs `published`; its commits land as the platform's do (`parent` must be the tip), and
 *  unless `seeded` it is not created yet. It has `/secrets/openai` unless `key` is false and the
 *  `itx.voice` rule when `voice`. Events on `/` land by hand (`land`), after a head at 7, as the
 *  stream's filter answers them; a publication moves the commit the project runs, as the project's
 *  reduce does. */
function project({
  voice = false,
  key = true,
  pin = true,
  seeded = true,
  published = "seed" as string | null,
} = {}) {
  const trees: Record<string, Record<string, string>> = {
    seed: { "package.json": manifest({ dependencies: pin ? { [name]: older } : {} }) },
  };
  const commits: { message: string; parent?: string | null }[] = [];
  const log: { type: string; offset: number; payload: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  const values: Record<string, string> = {};
  let tip = "seed";
  let publishedCommit = published;
  let movedAfterRead = false;
  // every verb of a repo whose certificate has not landed refuses (apps/os entity-lifecycle.ts)
  const notCreated = () =>
    new Error('repo /repos/config: not created — itx.repos.create("/repos/config") first');
  const repo = {
    tip: async () => {
      if (!seeded) throw notCreated();
      const read = tip;
      if (movedAfterRead) tip = "elsewhere";
      return read;
    },
    readFile: async (path: string, options?: { commitOid?: string }) => {
      if (!seeded) throw notCreated();
      return trees[options?.commitOid || tip]?.[path] ?? null;
    },
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
  const root = {
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
    land: (type: string, payload: Record<string, unknown>) => {
      log.push({ type, offset: 8 + log.length, payload });
      if (type === UPDATED) publishedCommit = String(payload.commitOid);
      for (const wake of waiters.splice(0)) wake();
    },
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
    secrets: {
      list: vi.fn(async () => (key ? [{ path: "/secrets/openai" }] : [])),
      set: vi.fn(),
    },
    rewriteRules: {
      get: vi.fn(async (match: string) =>
        voice && match === "itx.voice"
          ? { match, target: "itx.workers.get(…)", context: "/" }
          : null,
      ),
    },
    kv: {
      values,
      put: vi.fn(async (k: string, value: string) => {
        values[k] = value;
        return { ok: true as const };
      }),
    },
    append: vi.fn(async (..._events: object[]) => []),
    voice: { health: vi.fn().mockResolvedValue({ ok: true, projectId: "prj_voice" }) },
  };
  // The fake implements only the calls installing and upgrading make; typed once as what they take,
  // it keeps its mocks and in-memory records for the assertions.
  return root as typeof root &
    Parameters<typeof ensureVoiceAgent>[0] &
    Parameters<typeof upgradeVoice>[0] &
    Parameters<typeof installVoice>[0] &
    Parameters<typeof voiceVersion>[0];
}
