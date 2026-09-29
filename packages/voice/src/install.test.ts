import { codedError } from "iterate/lib";
import { expect, test, vi } from "vitest";
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

test("installVoice stores the screen font and writes the itx.voice rule to voice.ts of the published config, with no cache key", async () => {
  const root = project();
  await installVoice(root);
  expect(root.kv.values["voice/screen-font.css"]).toContain("Iterate Pixel");
  expect(root.append.mock).toMatchObject({
    calls: [
      [
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
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

test("a project created a moment ago is waited for until its config repo's init case installs voice", async () => {
  const root = project();
  root.waitForEvent
    .mockResolvedValueOnce(
      ruleEvent(3, { match: ["itx", "agents"], target: "itx.facets.get('agents')" }),
    )
    .mockResolvedValueOnce(ruleEvent(5, { match: ["itx", "voice"], target: "itx.workers.get(…)" }));
  expect(await ensureVoiceAgent(root)).toBe("ready");
  expect(root.waitForEvent.mock.calls.map(([filter]) => filter.afterOffset)).toEqual([0, 3]);
  expect(root.voice.health).toHaveBeenCalledOnce();
});

test("a project whose config repo is not created yet is waited for, not refused", async () => {
  const root = project({ seeded: false });
  root.waitForEvent.mockResolvedValueOnce(
    ruleEvent(4, { match: ["itx", "voice"], target: "itx.workers.get(…)" }),
  );
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
  if (packageJson) root.files["package.json"] = packageJson;
  else delete root.files["package.json"];
  expect(await voiceVersion(root)).toBe(version);
});

test("an upgrade commits the new pin on the tip it read, keeps the rest of package.json, and answers once its commit is published", async () => {
  const root = project();
  root.files["package.json"] = manifest({
    private: true,
    dependencies: { [name]: older, hono: "^4" },
  });
  const upgrade = upgradeVoice(root, newer);
  await vi.waitFor(() => expect(root.commits).toHaveLength(1));
  // another commit's publication lands first: not this one's
  root.publish("events.iterate.com/project/worker-updated", "elsewhere");
  root.publish("events.iterate.com/project/worker-updated", "commit-1");
  expect(await upgrade).toBe("commit-1");
  expect(root).toMatchObject({
    commits: [{ message: `Upgrade ${name} to ${newer}`, parent: "seed" }],
    files: {
      "package.json": manifest({ private: true, dependencies: { [name]: newer, hono: "^4" } }),
    },
  });
  // it waited from the head it read before committing
  expect(root.waitForEvent.mock.calls[0]![0]).toMatchObject({ afterOffset: 7 });
});

test("a config already at the build commits nothing and waits for no publication", async () => {
  const root = project();
  root.files["package.json"] = manifest({ dependencies: { [name]: newer } });
  expect(await upgradeVoice(root, newer)).toBe("seed");
  expect(root).toMatchObject({ commits: [] });
  expect(root.waitForEvent).not.toHaveBeenCalled();
});

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
  root.publish("events.iterate.com/project/worker-update-failed", "commit-1", {
    error: "voice.ts no longer exports VoiceAgentDurableObject",
  });
  await expect(upgrade).rejects.toThrow(
    "package.json pins the new build (config commit commit-), but its publication failed, so the project still runs the old one: voice.ts no longer exports VoiceAgentDurableObject",
  );
  expect(root.files["package.json"]).toContain(newer);
});

/** Where every rule and row of voice names its code: `voice.ts` of the project's published config
 *  (it restarts by that module's bundle, not a key). */
const published = { mainModule: "voice.ts", source: ["itx", ["cd", "/"], "config"] };

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** A project root over an in-memory config repo pinning `older` (none unless `pin`), whose commits
 *  land as the platform's do (`parent` must be the tip), with `/secrets/openai` unless `key` is
 *  false and the `itx.voice` rule when `voice`; `/`'s publications land by hand (`publish`), after a
 *  head at 7, and the rules its init case writes as `waitForEvent` answers them. */
function project({ voice = false, key = true, pin = true, seeded = true } = {}) {
  const files: Record<string, string> = {
    "package.json": manifest({ dependencies: pin ? { [name]: older } : {} }),
  };
  const commits: { message: string; parent?: string | null }[] = [];
  const log: { type: string; offset: number; payload: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  const values: Record<string, string> = {};
  let tip = "seed";
  let movedAfterRead = false;
  const repo = {
    tip: async () => {
      const read = tip;
      if (movedAfterRead) tip = "elsewhere";
      return read;
    },
    readFile: async (path: string) => {
      if (!seeded)
        throw new Error(
          'repo /repos/config: not created — itx.repos.create("/repos/config") first',
        );
      return files[path] ?? null;
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
      for (const change of input.changes) files[change.path] = change.content!;
      commits.push({ message: input.message, parent: input.parent });
      tip = `commit-${commits.length}`;
      return { commitOid: tip, changedPaths: input.changes.map((change) => change.path) };
    },
  };
  const root = {
    files,
    commits,
    moveMainAfterRead: () => void (movedAfterRead = true),
    publish: (type: string, commitOid: string, payload: Record<string, unknown> = {}) => {
      log.push({ type, offset: 8 + log.length, payload: { commitOid, ...payload } });
      for (const wake of waiters.splice(0)) wake();
    },
    repos: { get: () => repo },
    readEvents: vi.fn(async () => ({ events: [], scannedThroughOffset: 7, atHead: true })),
    waitForEvent: vi.fn(async ({ afterOffset = 0 }: { afterOffset?: number }) => {
      for (;;) {
        const next = log.find((event) => event.offset > afterOffset);
        if (next) return next;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    }),
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
    Parameters<typeof installVoice>[0];
}

/** A rewrite rule's fact on the root, as `waitForEvent` answers it. */
function ruleEvent(offset: number, payload: { match: string[]; target: string }) {
  return { type: "events.iterate.com/itx/rewrite-rule-configured", offset, payload };
}
