import { afterEach, describe, expect, it, vi } from "vitest";

const getEvent = vi.hoisted(() => vi.fn());
const directoryGet = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    PROJECT_DIRECTORY: { get: directoryGet },
    STREAM: {
      getByName: () => ({ getEvent }),
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");
const { ItxProspectiveProjectError } = await import("./itx/prospective-project-error.ts");

describe("ProjectRpcTarget waitUntilCreated", () => {
  afterEach(() => {
    vi.useRealTimers();
    getEvent.mockReset();
    directoryGet.mockReset();
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

  it("marks a prospective slug handle as an expected missing project", async () => {
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      ctx: { waitUntil: vi.fn() },
      prospectiveSlug: "fresh-project",
    } as never);

    await expect(target.identity()).rejects.toBeInstanceOf(ItxProspectiveProjectError);
  });

  it("keeps a missing canonical project ID as an ordinary error", async () => {
    directoryGet.mockResolvedValue(null);
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: { waitUntil: vi.fn() },
      projectId: "prj_missing",
      streamContext: { kind: "scope", scopePath: "/" },
    } as never);

    const error = await target.identity().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ItxProspectiveProjectError);
    expect(error).toMatchObject({
      message: "Project prj_missing is missing from the project directory.",
    });
  });
});
