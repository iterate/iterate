import { describe, expect, it, vi } from "vitest";

const getProject = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: getProject,
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("project processor-state reads", () => {
  it("releases the snapshot, processor facade, and Project Durable Object stub", async () => {
    const streams = [{ createdAt: "2026-07-29T00:00:00.000Z", path: "/" }];
    const snapshot = { state: { streams } };
    const snapshotDispose = vi.fn();
    const processorDispose = vi.fn();
    const projectDispose = vi.fn();
    Object.defineProperty(snapshot, Symbol.dispose, { value: snapshotDispose });
    const processor = { snapshot: vi.fn(async () => snapshot) };
    Object.defineProperty(processor, Symbol.dispose, { value: processorDispose });
    const project = { processor: Promise.resolve(processor) };
    Object.defineProperty(project, Symbol.dispose, { value: projectDispose });
    getProject.mockReturnValue(project);

    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.streams.list()).resolves.toEqual(streams);
    expect(snapshotDispose).toHaveBeenCalledOnce();
    expect(processorDispose).toHaveBeenCalledOnce();
    expect(projectDispose).toHaveBeenCalledOnce();
  });
});
