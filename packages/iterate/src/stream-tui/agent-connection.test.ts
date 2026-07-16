import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const connectItx = vi.hoisted(() => vi.fn());

vi.mock("../../../../apps/os/src/itx-client.ts", () => ({ connectItx }));

import { connectAgentFeed, type AgentConnectionStatus } from "./agent-connection.ts";

function agent(input: {
  snapshot: () => Promise<unknown>;
  breakConnection?: (callback: (error: unknown) => void) => void;
}) {
  return {
    onRpcBroken: vi.fn((callback: (error: unknown) => void) => input.breakConnection?.(callback)),
    processor: { snapshot: vi.fn(input.snapshot) },
    stream: {
      subscribe: vi.fn(async () => ({ [Symbol.dispose]: vi.fn() })),
    },
    create: vi.fn(),
    message: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  };
}

function connect(statuses: AgentConnectionStatus[]) {
  return connectAgentFeed({
    auth: { type: "bearer", token: "expired" },
    baseUrl: "https://os.example.com",
    projectId: "prj_test",
    agentPath: "/agents/test",
    createInput: {},
    replayAfterOffset: () => -1,
    onEvents: vi.fn(),
    onStatus: (status) => statuses.push(status),
  });
}

describe("connectAgentFeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectItx.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("stops permanently when authentication is rejected", async () => {
    connectItx.mockReturnValue(
      agent({ snapshot: async () => Promise.reject(new Error("missing or invalid auth")) }),
    );
    const statuses: AgentConnectionStatus[] = [];

    const connection = connect(statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.kind).toBe("failed"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connectItx).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toEqual({
      kind: "failed",
      detail: "authentication expired; restart iterate chat",
    });
    connection.dispose();
  });

  test("still reconnects after a transient transport failure", async () => {
    connectItx
      .mockReturnValueOnce(agent({ snapshot: async () => Promise.reject(new Error("edge reset")) }))
      .mockReturnValueOnce(
        agent({
          snapshot: async () => ({ state: { birthCertificate: { config: {} } } }),
        }),
      );
    const statuses: AgentConnectionStatus[] = [];

    const connection = connect(statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.kind).toBe("reconnecting"));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(statuses.at(-1)?.kind).toBe("live"));

    expect(connectItx).toHaveBeenCalledTimes(2);
    connection.dispose();
  });

  test("lets a terminal auth rejection cancel an already scheduled reconnect", async () => {
    connectItx.mockReturnValue(
      agent({
        breakConnection: (callback) => callback(new Error("edge reset")),
        snapshot: async () => Promise.reject(new Error("missing or invalid auth")),
      }),
    );
    const statuses: AgentConnectionStatus[] = [];

    const connection = connect(statuses);
    await vi.waitFor(() => expect(statuses.at(-1)?.kind).toBe("failed"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connectItx).toHaveBeenCalledTimes(1);
    connection.dispose();
  });
});
