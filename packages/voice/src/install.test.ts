import { expect, test, vi } from "vitest";
import { ensureVoiceAgent, installVoice, upgradeVoice, voiceFolder } from "./install.ts";

const versions = {
  agents: "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@abc1234",
  voice: "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@abc1234",
};

test("the voice folder names its main module in package.json", () => {
  const folder = voiceFolder(versions.voice);
  expect(JSON.parse(folder["package.json"]!)).toEqual({
    main: "worker.ts",
    dependencies: { "@iterate-com/voice": versions.voice },
  });
  expect(folder["worker.ts"]).toContain("VoiceAgentDurableObject");
});

test("a project without voice gets the agents and voice folders in one commit, installed from it", async () => {
  const root = project();
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  expect(root.commits.map((commit) => commit.changes.map((change) => change.path))).toEqual([
    [
      "agents/package.json",
      "agents/index.ts",
      "voice/package.json",
      "voice/worker.ts",
      "package.json",
    ],
  ]);
  expect(root).toMatchObject({ modulesReadAt: ["commit-1", "commit-1"] });
  expect(root.files["voice/package.json"]).toContain(versions.voice);
  // the root lists both packages, so `tsc` over the repo resolves the folders' imports
  expect(JSON.parse(root.files["package.json"]!)).toMatchObject({
    devDependencies: {
      "@iterate-com/agents": versions.agents,
      "@iterate-com/voice": versions.voice,
      typescript: "^7.0.2",
    },
  });
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

test("the agents app's first load runs beside voice's health check, not before it", async () => {
  const root = project();
  // the upgrade settles only once health() has been asked: installing them one after the other
  // never gets there
  const { promise: healthAsked, resolve } = Promise.withResolvers<void>();
  root.voice.health.mockImplementation(async () => {
    resolve();
    return { ok: true };
  });
  root.invoke.mockImplementation(() => healthAsked);
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  expect(root.invoke).toHaveBeenCalledWith(["itx", "agents", ["upgrade"]]);
});

test("a voice/ folder the project already has is installed as it is, never overwritten", async () => {
  const root = project();
  const own = {
    "package.json": '{"dependencies":{"@iterate-com/voice":"^1"}}',
    "worker.ts": "own",
  };
  root.files["voice/package.json"] = own["package.json"];
  root.files["voice/worker.ts"] = own["worker.ts"];
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  expect(root.commits.map((commit) => commit.changes.map((change) => change.path))).toEqual([
    ["agents/package.json", "agents/index.ts", "package.json"],
  ]);
  expect(JSON.parse(root.kv.values["voice/runtime"]!)).toMatchObject({ source: own });
});

test("a project with the agents app gets only the voice folder, and its agents are left as they are", async () => {
  const root = project();
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.agents", target: "own-agents" },
  });
  root.append.mockClear();
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  expect(root.commits.map((commit) => commit.changes.map((change) => change.path))).toEqual([
    ["voice/package.json", "voice/worker.ts", "package.json"],
  ]);
  expect(root.processors.enable).not.toHaveBeenCalled();
  expect(root.invoke).not.toHaveBeenCalled();
  expect(root.append.mock.calls.map(([event]) => event.payload.match)).toEqual(["itx.voice"]);
});

test("a project without an OpenAI key and none given is asked for one, and nothing is installed", async () => {
  const root = project();
  root.secrets.list.mockResolvedValue([]);
  expect(await ensureVoiceAgent(root, versions)).toBe("needs-openai-key");
  expect(root).toMatchObject({ commits: [] });
  expect(root.append).not.toHaveBeenCalled();
});

test("a broken existing voice service is reported without replacing it", async () => {
  const root = project();
  root.rewriteRules.get.mockResolvedValue({ match: "itx.voice", target: "custom", context: "/" });
  root.voice.health.mockRejectedValue(new Error("existing service unavailable"));
  await expect(ensureVoiceAgent(root, versions)).rejects.toThrow("existing service unavailable");
  expect(root).toMatchObject({ commits: [] });
  expect(root.append).not.toHaveBeenCalled();
  expect(root.kv.put).not.toHaveBeenCalled();
});

test("voice refuses a project without the agents app", async () => {
  const root = project();
  await expect(installVoice(root, voiceFolder(versions.voice))).rejects.toThrow(
    "Voice needs the agents app",
  );
  expect(root.append).not.toHaveBeenCalled();
});

test("an upgrade rewrites voice/ at the new build, mounts it, and asks the new build for health", async () => {
  const root = project();
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  root.voice.health.mockClear();
  const newer = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@def5678";

  await upgradeVoice(root, newer);
  expect(root.commits.at(-1)).toMatchObject({
    message: `Upgrade @iterate-com/voice to ${newer}`,
    changes: [
      { path: "voice/package.json", content: voiceFolder(newer)["package.json"] },
      { path: "voice/worker.ts" },
      { path: "package.json" },
    ],
  });
  expect(JSON.parse(root.kv.values["voice/runtime"]!)).toMatchObject({
    source: voiceFolder(newer),
  });
  expect(root.voice.health).toHaveBeenCalledOnce();
  // the agents app keeps its own build
  expect(root.files["agents/package.json"]).toContain(versions.agents);
});

test("a new voice build that fails its health check is an install that failed", async () => {
  const root = project();
  expect(await ensureVoiceAgent(root, versions)).toBe("ready");
  root.voice.health.mockRejectedValue(new Error("No matching export VoiceDelegateDurableObject"));
  await expect(
    upgradeVoice(root, "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@def5678"),
  ).rejects.toThrow(
    "installing it failed, so the project may still run the old one: No matching export VoiceDelegateDurableObject",
  );
});

/** A project root over an in-memory config repo, whose rewrite rules are the ones appended. */
function project() {
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ devDependencies: { typescript: "^7.0.2" } }, null, 2)}\n`,
  };
  const commits: { message: string; changes: { path: string; content: string }[] }[] = [];
  const modulesReadAt: (string | undefined)[] = [];
  const rules: Record<string, unknown> = {};
  const values: Record<string, string> = {};
  const append = vi.fn(async (event: any) => {
    if (event.type === "events.iterate.com/itx/rewrite-rule-configured")
      rules[event.payload.match] = event.payload;
    return [];
  });
  const root = {
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
    modulesReadAt,
    repos: {
      get: () => ({
        listFiles: async () => ({
          commitOid: commits.length ? `commit-${commits.length}` : "seed",
          paths: Object.keys(files),
        }),
        readFile: async (path: string) => files[path] ?? null,
        commitFiles: async (input: { message: string; changes: any[] }) => {
          commits.push(input);
          for (const change of input.changes) files[change.path] = change.content;
          return { commitOid: `commit-${commits.length}`, changedPaths: [] };
        },
        modules: async ({ dir, commitOid }: { dir?: string; commitOid?: string }) => {
          modulesReadAt.push(commitOid);
          return Object.fromEntries(
            Object.entries(files)
              .filter(([path]) => path.startsWith(`${dir}/`))
              .map(([path, content]) => [path.slice(dir!.length + 1), content]),
          );
        },
      }),
    },
    append,
    invoke: vi.fn(),
    voice: { health: vi.fn().mockResolvedValue({ ok: true }) },
  };
  // The fake implements only the calls installing makes; typed once as what ensureVoiceAgent takes,
  // it keeps its mocks and in-memory records for the assertions.
  return root as typeof root & Parameters<typeof ensureVoiceAgent>[0];
}
