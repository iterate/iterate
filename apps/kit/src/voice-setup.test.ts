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

import { prepareDeviceVoice } from "./voice-setup.ts";

const input = {
  baseUrl: "https://os.example.test",
  projectSlug: "home",
  projectApiKey: "itxk_test",
  deviceId: "satellite1",
};

function project(
  input: {
    health?: { ok: boolean; projectId: string };
    secret?: { created?: boolean; hasMaterial?: boolean };
  } = {},
) {
  const commits: unknown[] = [];
  const append = vi.fn(async () => [{ offset: 42 }]);
  const health = vi.fn(async () => input.health || { ok: true, projectId: "prj_home" });
  const waitUntilProcessed = vi.fn(async () => undefined);
  return {
    commits,
    append,
    health,
    waitUntilProcessed,
    value: {
      identity: async () => ({ projectId: "prj_home", slug: "home" }),
      secrets: {
        get: () => ({
          __describe: async () => input.secret || { created: true, hasMaterial: true },
        }),
      },
      capabilityHosts: { get: () => ({ processor: { waitUntilProcessed } }) },
      streams: { get: () => ({ append }) },
      workers: { get: () => ({ health }) },
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
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("installs and durably mounts the setup worker from the browser project credential", async () => {
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
  expect(fixture.append).toHaveBeenCalledWith({
    type: "events.iterate.com/capability-host/capability-provided",
    payload: {
      type: "itx-call",
      path: ["voice"],
      expression: ["workers", ["get", expect.any(Object)]],
      flattenNestedPaths: true,
      instructions: "Set up a fresh voice conversation stream for a Kit device.",
    },
  });
  expect(fixture.health).toHaveBeenCalledOnce();
  expect(fixture.health).toHaveBeenCalledBefore(fixture.append);
  expect(fixture.waitUntilProcessed).toHaveBeenCalledWith({ offset: 42 });
  expect(fixture.commits).toHaveLength(1);
  const refConfigChange = (
    fixture.commits[0] as { changes: { path: string; content: string }[] }
  ).changes.find((change) => change.path === "kit-voice-agent/ref-config.ts");
  expect(refConfigChange?.content).toContain('"guestFile": "kit-voice-agent.ts"');
  expect(refConfigChange?.content).toMatch(
    /"durableWorkerKey": "kit-voice-agent-facet-[a-f0-9]{32}"/,
  );
  expect(client.disconnect).toHaveBeenCalledOnce();
});

test("does not mount an unhealthy installed worker", async () => {
  const fixture = project({ health: { ok: true, projectId: "prj_other" } });
  client.connect.mockResolvedValue(fixture.value);

  await expect(prepareDeviceVoice(input)).rejects.toThrow(/health check/);

  expect(fixture.health).toHaveBeenCalledOnce();
  expect(fixture.append).not.toHaveBeenCalled();
  expect(client.disconnect).toHaveBeenCalledOnce();
});

test("checks the OpenAI secret before writing the isolated guest", async () => {
  const fixture = project({ secret: { created: true, hasMaterial: false } });
  client.connect.mockResolvedValue(fixture.value);

  await expect(prepareDeviceVoice(input)).rejects.toThrow(/secrets\/openai/);

  expect(fixture.commits).toEqual([]);
  expect(client.disconnect).toHaveBeenCalledOnce();
});

test("rejects an unknown device before connecting", async () => {
  await expect(prepareDeviceVoice({ ...input, deviceId: "unknown-device" })).rejects.toThrow(
    /Unsupported voice device/,
  );

  expect(client.connect).not.toHaveBeenCalled();
  expect(client.disconnect).not.toHaveBeenCalled();
});
