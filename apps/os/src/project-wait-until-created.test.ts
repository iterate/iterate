import { afterEach, describe, expect, it, vi } from "vitest";

const getEvent = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    STREAM: {
      getByName: () => ({ getEvent }),
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("ProjectRpcTarget waitUntilCreated", () => {
  afterEach(() => {
    vi.useRealTimers();
    getEvent.mockReset();
  });

  it("bounds the initial creation-request read by the public timeout", async () => {
    vi.useFakeTimers();
    getEvent.mockReturnValue(new Promise(() => undefined));
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: { waitUntil: vi.fn() },
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    const waiting = target.waitUntilCreated({ timeoutMs: 100 });
    const rejection = expect(waiting).rejects.toThrow("Project creation timed out after 100ms.");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(getEvent).toHaveBeenCalledOnce();
  });
});
