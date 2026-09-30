import { codedError } from "iterate/lib";
import { expect, onTestFinished, test, vi } from "vitest";
import { ensureVoiceAgent, installVoice, upgradeVoice, voiceVersion } from "./install.ts";

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
  const ready = ensureVoiceAgent(root);
  await vi.waitFor(() => expect(root.waitForEvent).toHaveBeenCalledTimes(3));
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  expect(await ready).toBe("ready");
  expect(root.waitForEvent.mock.calls.map(([filter]) => filter.afterOffset)).toEqual([0, 1, 2]);
  expect(root.voice.health).toHaveBeenCalledOnce();
});

test("a project whose config repo is created but not yet seeded is waited for, not refused", async () => {
  const root = project();
  root.repos.get("/repos/config").tip = async () => null;
  const ready = ensureVoiceAgent(root);
  await vi.waitFor(() => expect(root.waitForEvent).toHaveBeenCalledTimes(1));
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  expect(await ready).toBe("ready");
});

test("a voice rule the root no longer holds is not installed: readiness waits for the one init writes again", async () => {
  const root = project();
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  root.land(RULE, { match: ["itx", "voice"], target: null });
  const ready = ensureVoiceAgent(root);
  await vi.waitFor(() => expect(root.waitForEvent).toHaveBeenCalledTimes(3));
  expect(root.voice.health).not.toHaveBeenCalled();
  root.land(RULE, { match: ["itx", "voice"], target: ["itx", "workers", ["get", published]] });
  expect(await ready).toBe("ready");
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
    const root = project();
    root.trees.seed!["package.json"] = manifest({
      private: true,
      dependencies: { [name]: older, hono: "^4" },
    });
    const upgrade = upgradeVoice(root, newer);
    await vi.waitFor(() => expect(root.commits).toHaveLength(1));
    root.land(outcome, { commitOid: "commit-1", error });
    if (error) await expect(upgrade).rejects.toThrow(`The upgrade was not published: ${error}`);
    else expect(await upgrade).toBe("commit-1");
    expect(root).toMatchObject({
      commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
      trees: {
        "commit-1": {
          "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
        },
      },
    });
    expect(root.waitForEvent).toHaveBeenCalledExactlyOnceWith({
      type: [UPDATED, FAILED],
      payload: { commitOid: "commit-1" },
      afterOffset: 0,
      timeoutMs: 120_000,
    });
  },
);

test("the platform's give-up for now (`unavailable`) is no outcome: an upgrade waits past it for the publication the platform still owes", async () => {
  const root = project();
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  const upgrade = upgradeVoice(root, newer);
  await vi.waitFor(() => expect(root.commits).toHaveLength(1));
  // a minute later the give-up lands: the wait after it has what is left of the two minutes
  vi.setSystemTime(Date.now() + 60_000);
  root.land(FAILED, { commitOid: "commit-1", error: "esm.sh answered 503", unavailable: true });
  root.land(UPDATED, { commitOid: "commit-1" });
  expect(await upgrade).toBe("commit-1");
  const [, [second]] = root.waitForEvent.mock.calls;
  expect(second?.timeoutMs).toBeLessThanOrEqual(60_000);
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
 *  `itx.voice` rule when `voice`. Events on `/` land by hand (`land`), as the stream's filter
 *  answers them; a publication moves the commit the project runs, as the project's
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
  // every verb of a repo whose certificate has not landed refuses (core/os entity-lifecycle.ts)
  const notCreated = () =>
    new Error('repo /repos/config: not created — itx.repos.create("/repos/config") first');
  const repo = {
    tip: async () => {
      if (!seeded) throw notCreated();
      return tip;
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
    land: (type: string, payload: Record<string, unknown>) => {
      log.push({ type, offset: 1 + log.length, payload });
      if (type === UPDATED) publishedCommit = String(payload.commitOid);
      for (const wake of waiters.splice(0)) wake();
    },
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
    secrets: {
      list: vi.fn(async () => (key ? [{ path: "/secrets/openai" }] : [])),
      set: vi.fn(),
    },
    rewriteRules: {
      // the root's rule as it stands: the option, else the last `itx.voice` rule landed on the log
      get: vi.fn(async (match: string) => {
        if (match !== "itx.voice") return null;
        if (voice) return { match, target: "itx.workers.get(…)", context: "/" };
        const last = log.findLast(
          (event) =>
            event.type === RULE && JSON.stringify(event.payload.match) === '["itx","voice"]',
        );
        return last?.payload.target ? { match, target: last.payload.target, context: "/" } : null;
      }),
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
