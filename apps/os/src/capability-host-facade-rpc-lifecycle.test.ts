import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("CapabilityHostRpcTarget facade calls", () => {
  afterEach(() => getStream.mockReset());

  it("releases its facade and detaches a script result after reading it", async () => {
    const facadeDispose = vi.fn();
    const resultDispose = vi.fn();
    const result = { data: { answer: 42 }, executionId: "execution-1" };
    Object.defineProperty(result, Symbol.dispose, { value: resultDispose });
    const facade = {
      getScriptResult: vi.fn(async () => result),
    };
    Object.defineProperty(facade, Symbol.dispose, { value: facadeDispose });
    getStream.mockReturnValue({ processorFacade: vi.fn(async () => facade) });

    const project = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      projectId: "prj_preview",
      streamContext: { kind: "scope", scopePath: "/" },
    } as never);

    const returned = await project.capabilityHosts.get("/").getScriptResult("execution-1");

    expect(returned).toEqual({ data: { answer: 42 }, executionId: "execution-1" });
    expect(returned).not.toBe(result);
    expect(Reflect.has(returned, Symbol.dispose)).toBe(false);
    expect(facadeDispose).toHaveBeenCalledOnce();
    expect(resultDispose).toHaveBeenCalledOnce();
  });
});
