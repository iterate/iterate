import { expect, test, vi } from "vitest";
import { ensureVoiceAgent, installVoice, voiceFolder } from "./install.ts";

const versions = {
  agents: "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@abc1234",
  voice: "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@abc1234",
};

test("a project without voice gets the agents and voice folders committed, installed from those commits", async () => {
  const root = project();
  expect(await ensureVoiceAgent(root as never, versions)).toBe("ready");
  expect(root.commits.map((commit) => commit.changes.map((change) => change.path))).toEqual([
    ["agents/package.json", "agents/index.ts"],
    ["voice/package.json", "voice/worker.ts"],
  ]);
  expect(root.files["voice/package.json"]).toContain(versions.voice);
  expect(root.processors.enable).toHaveBeenCalledWith(
    "agents",
    expect.objectContaining({ className: "AgentCollectionDurableObject" }),
  );
  const voiceRule = root.append.mock.calls
    .map(([event]) => event.payload)
    .find((payload) => payload.match === "itx.voice");
  expect(voiceRule).toMatchObject({
    target: [
      "itx",
      "workers",
      [
        "get",
        { source: voiceFolder(versions.voice), cacheKey: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    ],
  });
  expect(JSON.parse(root.kv.values["voice/runtime"]!)).toEqual({
    cacheKey: voiceRule.target[2][1].cacheKey,
    source: voiceFolder(versions.voice),
  });
  expect(root.kv.values["voice/screen-font.css"]).toContain("Iterate Pixel");
});

test("a voice/ folder the project already has is installed as it is, never overwritten", async () => {
  const root = project();
  const own = {
    "package.json": '{"dependencies":{"@iterate-com/voice":"^1"}}',
    "worker.ts": "own",
  };
  root.files["voice/package.json"] = own["package.json"];
  root.files["voice/worker.ts"] = own["worker.ts"];
  expect(await ensureVoiceAgent(root as never, versions)).toBe("ready");
  expect(root.commits.map((commit) => commit.changes[0]!.path)).toEqual(["agents/package.json"]);
  expect(JSON.parse(root.kv.values["voice/runtime"]!)).toMatchObject({ source: own });
});

test("a project without an OpenAI key and none given is asked for one, and nothing is installed", async () => {
  const root = project();
  root.secrets.list.mockResolvedValue([]);
  expect(await ensureVoiceAgent(root as never, versions)).toBe("needs-openai-key");
  expect(root).toMatchObject({ commits: [] });
  expect(root.append).not.toHaveBeenCalled();
});

test("a broken existing voice service is reported without replacing it", async () => {
  const root = project();
  root.rewriteRules.get.mockResolvedValue({ match: "itx.voice", target: "custom", context: "/" });
  root.voice.health.mockRejectedValue(new Error("existing service unavailable"));
  await expect(ensureVoiceAgent(root as never, versions)).rejects.toThrow(
    "existing service unavailable",
  );
  expect(root).toMatchObject({ commits: [] });
  expect(root.append).not.toHaveBeenCalled();
  expect(root.kv.put).not.toHaveBeenCalled();
});

test("voice refuses a project without the agents app", async () => {
  const root = project();
  await expect(installVoice(root as never, voiceFolder(versions.voice))).rejects.toThrow(
    "Voice needs the agents app",
  );
  expect(root.append).not.toHaveBeenCalled();
});

/** A project root over an in-memory config repo, whose rewrite rules are the ones appended. */
function project() {
  const files: Record<string, string> = {};
  const commits: { message: string; changes: { path: string; content: string }[] }[] = [];
  const rules: Record<string, unknown> = {};
  const values: Record<string, string> = {};
  const append = vi.fn(async (event: any) => {
    if (event.type === "events.iterate.com/itx/rewrite-rule-configured")
      rules[event.payload.match] = event.payload;
    return [];
  });
  return {
    files,
    commits,
    whoami: vi.fn().mockResolvedValue({ path: "/" }),
    waitForEvent: vi.fn().mockResolvedValue({ type: "events.iterate.com/project/created" }),
    processors: { enable: vi.fn().mockResolvedValue({ name: "agents" }) },
    secrets: {
      list: vi.fn().mockResolvedValue([{ path: "/secrets/openai" }]),
      set: vi.fn(),
    },
    rewriteRules: { get: vi.fn(async (match: string) => rules[match] ?? null) },
    kv: {
      values,
      put: vi.fn(async (key: string, value: string) => {
        values[key] = value;
        return { ok: true as const };
      }),
    },
    repos: {
      get: () => ({
        readFile: async (path: string) => files[path] ?? null,
        commitFiles: async (input: { message: string; changes: any[] }) => {
          commits.push(input);
          for (const change of input.changes) files[change.path] = change.content;
          return { commitOid: `commit-${commits.length}`, changedPaths: [] };
        },
        modules: async ({ dir }: { dir?: string; commitOid?: string }) =>
          Object.fromEntries(
            Object.entries(files)
              .filter(([path]) => path.startsWith(`${dir}/`))
              .map(([path, content]) => [path.slice(dir!.length + 1), content]),
          ),
      }),
    },
    append,
    invoke: vi.fn(),
    voice: { health: vi.fn().mockResolvedValue({ ok: true }) },
  };
}
