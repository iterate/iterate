import { beforeEach, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({
  configure: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("iterate/client", () => ({
  configureIterateSession: client.configure,
  connectItx: client.connect,
  disconnectIterateSession: client.disconnect,
}));

import { kitFacetKeyForSources, prepareDeviceVoice } from "./voice-setup.ts";

const input = {
  baseUrl: "https://os.example.test",
  projectSlug: "home",
  projectApiKey: "itxk_test",
  deviceId: "satellite1",
};

function project(
  input: { state?: unknown; secret?: { created?: boolean; hasMaterial?: boolean } } = {},
) {
  const commits: unknown[] = [];
  const setup = vi.fn(async (options: unknown) => ({
    streamPath: (options as { streamPath: string }).streamPath,
    warmMs: 1,
  }));
  return {
    commits,
    setup,
    value: {
      identity: async () => ({ projectId: "prj_home", slug: "home" }),
      secrets: {
        get: () => ({
          __describe: async () => input.secret || { created: true, hasMaterial: true },
        }),
      },
      streams: {
        get: () => ({
          subscriptions: {
            get: () => ({
              describe: async () => (input.state === undefined ? null : {}),
              processor: { getRuntimeState: async () => ({ snapshot: { state: input.state } }) },
            }),
          },
        }),
      },
      repo: {
        readFile: async ({ path }: { path: string }) =>
          path === "package.json"
            ? {
                commitOid: "a",
                content: '{"name":"test","dependencies":{"iterate":"workspace:*"}}',
              }
            : null,
        commitFiles: async (change: unknown) => {
          commits.push(change);
          return { commitOid: "a", changedPaths: [], noChanges: false };
        },
      },
      workers: { get: () => ({ setupVoiceAgent: setup }) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("sets up the canonical board stream from the browser project credential", async () => {
  const fixture = project();
  client.connect.mockResolvedValue(fixture.value);

  await expect(prepareDeviceVoice(input)).resolves.toEqual({
    projectId: "prj_home",
    streamPath: "/agents/voice/v23/satellite1",
  });

  expect(client.configure).toHaveBeenCalledWith({
    baseUrl: input.baseUrl,
    credentials: { type: "project-secret", projectSlug: "home", secret: "itxk_test" },
  });
  expect(fixture.setup).toHaveBeenCalledWith({
    streamPath: "/agents/voice/v23/satellite1",
    instructions: "",
    backend: {},
    visemes: false,
  });
  expect(fixture.commits).toHaveLength(1);
  const refChange = (
    fixture.commits[0] as { changes: { path: string; content: string }[] }
  ).changes.find((change) => change.path === "kit-voice-agent/ref.ts");
  expect(refChange?.content).toContain('VOICE_AGENT_GUEST_FILE = "kit-voice-agent.ts"');
  expect(refChange?.content).toMatch(/durableWorkerKey: "kit-voice-agent-facet-[a-f0-9]{32}",/);
  expect(client.disconnect).toHaveBeenCalledOnce();
});

test("uses a stable new facet key for the same source bundle", async () => {
  const sources = {
    "worker.ts": "worker",
    "voice-agent.ts": "agent",
    "face.ts": "face",
    "ref.ts": "ref",
    "setup-options.ts": "options",
    "viseme.ts": "viseme",
    "viseme-model.generated.ts": "model",
  };

  const first = await kitFacetKeyForSources(sources);
  await expect(kitFacetKeyForSources(sources)).resolves.toBe(first);
  await expect(
    kitFacetKeyForSources({ ...sources, "voice-agent.ts": "changed agent" }),
  ).resolves.not.toBe(first);
});

test("preserves configured instructions and model, then enables visemes only on Waveshare", async () => {
  const fixture = project({
    state: {
      instructions: "Be brief.",
      backend: { model: "openai/gpt-6" },
      call: null,
    },
  });
  client.connect.mockResolvedValue(fixture.value);

  await prepareDeviceVoice({ ...input, deviceId: "waveshare" });

  expect(fixture.setup).toHaveBeenCalledWith({
    streamPath: "/agents/voice/v23/waveshare",
    instructions: "Be brief.",
    backend: { model: "openai/gpt-6" },
    visemes: true,
  });
});

test("refuses setup while a call is active and still releases browser authority", async () => {
  const fixture = project({
    state: {
      call: { activation: "a", conversationId: "c" },
    },
  });
  client.connect.mockResolvedValue(fixture.value);

  await expect(prepareDeviceVoice(input)).rejects.toThrow(/active call/);

  expect(fixture.commits).toEqual([]);
  expect(fixture.setup).not.toHaveBeenCalled();
  expect(client.disconnect).toHaveBeenCalledOnce();
});

test("checks the OpenAI secret before writing the isolated guest", async () => {
  const fixture = project({ secret: { created: true, hasMaterial: false } });
  client.connect.mockResolvedValue(fixture.value);

  await expect(prepareDeviceVoice(input)).rejects.toThrow(/secrets\/openai/);

  expect(fixture.commits).toEqual([]);
  expect(client.disconnect).toHaveBeenCalledOnce();
});
