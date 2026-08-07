import { describe, expect, it, vi } from "vitest";

const getStream = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    STREAM: {
      getByName: getStream,
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("project processor-state reads", () => {
  it("releases the snapshot, processor facade, and Stream Durable Object stub", async () => {
    const streams = [{ createdAt: "2026-07-29T00:00:00.000Z", path: "/" }];
    const snapshot = { state: { streams } };
    const snapshotDispose = vi.fn();
    const facadeDispose = vi.fn();
    const streamDispose = vi.fn();
    Object.defineProperty(snapshot, Symbol.dispose, { value: snapshotDispose });
    const facade = { snapshot: vi.fn(async () => snapshot) };
    Object.defineProperty(facade, Symbol.dispose, { value: facadeDispose });
    const stream = { processorFacade: vi.fn(async () => facade) };
    Object.defineProperty(stream, Symbol.dispose, { value: streamDispose });
    getStream.mockReturnValue(stream);

    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.streams.list()).resolves.toEqual(streams);
    expect(snapshotDispose).toHaveBeenCalledOnce();
    expect(facadeDispose).toHaveBeenCalledOnce();
    expect(streamDispose).toHaveBeenCalledOnce();
  });
});
