import { beforeEach, describe, expect, it, vi } from "vitest";

const projectDescribe = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: () => ({ describe: projectDescribe }),
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("ProjectRpcTarget description", () => {
  beforeEach(() => {
    projectDescribe.mockReset();
    vi.restoreAllMocks();
  });

  it("replays one read after a Project Durable Object lifecycle reset", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    projectDescribe
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce({ name: "Preview project", projectId: "prj_preview" });
    const capabilityHostDescribe = vi.fn(async () => ({ capabilities: [] }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: {
        path: "/",
        __describe: capabilityHostDescribe,
      },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.__describe()).resolves.toMatchObject({
      name: "Preview project",
      projectId: "prj_preview",
    });
    expect(projectDescribe).toHaveBeenCalledTimes(2);
    expect(capabilityHostDescribe).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith("project description retrying after Durable Object reset", {
      error: reset,
      projectId: "prj_preview",
      scopePath: "/",
    });
  });

  it("replays the same read boundary after a Capability Host lifecycle reset", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), {
      durableObjectReset: true,
    });
    projectDescribe.mockResolvedValue({ name: "Preview project", projectId: "prj_preview" });
    const capabilityHostDescribe = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce({ capabilities: [] });
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: {
        path: "/",
        __describe: capabilityHostDescribe,
      },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.__describe()).resolves.toMatchObject({
      name: "Preview project",
      projectId: "prj_preview",
    });
    expect(projectDescribe).toHaveBeenCalledTimes(2);
    expect(capabilityHostDescribe).toHaveBeenCalledTimes(2);
  });
});
