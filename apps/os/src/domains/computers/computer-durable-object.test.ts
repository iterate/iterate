import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";

const h = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  ready: vi.fn(async () => undefined),
  stub: vi.fn(() => ({ kind: "workspace-stub" })),
}));

vi.mock("@cloudflare/computer", () => ({
  Workspace: class {
    readonly artifacts = {};
    readonly assets = {};
    readonly fs = { mkdir: h.mkdir };
    readonly git = {};
    readonly runtime = {};
    readonly useThink = false;
    readonly ready = h.ready;
    readonly stub = h.stub;
  },
}));

vi.mock("@cloudflare/computer/backends/worker-shell", () => ({
  WorkerShellBackend: class {},
}));

vi.mock("@cloudflare/computer/git", () => ({
  createGitClient: () => ({}),
}));

vi.mock("iterate/processors/cloudflare", () => ({
  createStreamProcessorRegistry: () => ({
    catchUp: vi.fn(async () => undefined),
    handleAlarm: vi.fn(async () => undefined),
    reads: () => ({
      catchUp: vi.fn(async () => undefined),
      currentState: {
        birthCertificate: {
          agentPath: "/agents/alice",
          config: {
            defaultBackend: "worker-shell",
            defaultTimeoutMs: 30_000,
            workingDirectory: "/workspace",
          },
        },
        config: {
          defaultBackend: "worker-shell",
          defaultTimeoutMs: 30_000,
          workingDirectory: "/workspace",
        },
      },
      waitUntilEvent: vi.fn(async () => undefined),
    }),
    register: (processor: unknown) => processor,
    wakeStreamProcessor: vi.fn(async () => ({})),
  }),
}));

vi.mock("../../env.ts", () => ({ workerVersion: () => "test-version" }));

vi.mock("../../rpc-targets.ts", () => ({
  StreamProcessorRpcTarget: class {},
  StreamRpcTarget: class {},
}));

vi.mock("./computer-processor-implementation.ts", () => ({
  ComputerProcessor: class {},
}));

const { ComputerDurableObject } = await import("./computer-durable-object.ts");

function computer(): InstanceType<typeof ComputerDurableObject> {
  const name = "prj_test.iterate/computers/agents/alice";
  const ctx = {
    abort: vi.fn(),
    id: { name, toString: () => name },
    storage: {},
  } as unknown as DurableObjectState;
  return new ComputerDurableObject(ctx, {
    ARTIFACTS: {},
    LOADER: {},
  } as Env);
}

describe("ComputerDurableObject backend allocation", () => {
  it("does not connect an execution backend during birth or ordinary workspace access", async () => {
    const value = computer();

    await value.prepare();
    await value.__getWorkspaceStub();

    expect(h.ready.mock.calls).toEqual([[], []]);
    expect(h.mkdir).toHaveBeenCalledWith("/workspace", { recursive: true });
    expect(h.stub).toHaveBeenCalledOnce();
  });
});
