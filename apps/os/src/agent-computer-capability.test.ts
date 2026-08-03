import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  ComputerArtifacts,
  ComputerFilesystem,
  ComputerRuntime,
} from "./itx-api.generated.ts";

const computerMocks = vi.hoisted(() => ({
  getComputer: vi.fn(),
  workspaceUseThink: vi.fn(),
}));

vi.mock("./env.ts", () => ({
  itxEnv: {
    COMPUTER: {
      getByName: computerMocks.getComputer,
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

function projectAt(scopePath: string): InstanceType<typeof ProjectRpcTarget> {
  return new ProjectRpcTarget({
    auth: { assertCanAccessProject: vi.fn() },
    capabilityHost: { path: scopePath },
    ctx: {},
    streamContext: { kind: "scope", scopePath },
    projectId: "prj_test",
  } as never);
}

describe("agent Computer capability boundary", () => {
  it("preserves upstream callback, signal, file, and runtime result precision", () => {
    const assertContract = async (
      artifacts: ComputerArtifacts,
      filesystem: ComputerFilesystem,
      runtime: ComputerRuntime,
    ) => {
      const bytes = await filesystem.readFile("/workspace/data.bin");
      const text = await filesystem.readFile("/workspace/data.txt", "utf8");
      expectTypeOf(bytes).toEqualTypeOf<ReadableStream<Uint8Array>>();
      expectTypeOf(text).toEqualTypeOf<string>();

      const byteExecution = await runtime.exec("printf data");
      const textExecution = await runtime.exec("printf data", { encoding: "utf8" });
      expectTypeOf((await byteExecution.result()).stdout).toEqualTypeOf<Uint8Array>();
      expectTypeOf((await textExecution.result()).stdout).toEqualTypeOf<string>();
      await textExecution.kill("SIGTERM");
      // @ts-expect-error Cloudflare Computer accepts only its four KillSignal values.
      await textExecution.kill("SIGUSR1");

      await artifacts.cli({
        argv: ["create", "repo"],
        remoteAdd: async ({ force, name, url }) => ({
          message: `${name}:${url}:${String(force)}`,
          ok: true,
        }),
      });
    };

    expect(assertContract).toBeTypeOf("function");
  });

  it("reads useThink as a scalar inside the Computer Durable Object", async () => {
    computerMocks.workspaceUseThink.mockResolvedValue(false);
    computerMocks.getComputer.mockReturnValue({
      workspaceUseThink: computerMocks.workspaceUseThink,
    });

    const itx = projectAt("/agents/alice");

    expect(itx.computer).toBeDefined();
    await expect(itx.computer?.useThink).resolves.toBe(false);
    expect(computerMocks.workspaceUseThink).toHaveBeenCalledOnce();
  });

  it("trusts an agent scope with the full Computer catalog", () => {
    const itx = projectAt("/agents/alice");

    expect(itx.computers.get("/computers/agents/bob")).toBeDefined();
    const ownComputer = itx.computer;
    expect(ownComputer).toBeDefined();
    if (ownComputer === undefined) throw new Error("agent scope has no Computer");
    const publicMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(ownComputer));
    expect(publicMembers).toEqual(
      expect.arrayContaining([
        "fs",
        "runtime",
        "git",
        "assets",
        "artifacts",
        "useThink",
        "create",
        "kill",
        "whoami",
        "processor",
        "state",
        "getConfig",
        "configure",
      ]),
    );
  });

  it("keeps the administrative Computer catalog available outside agent scopes", () => {
    const itx = projectAt("/");

    expect(itx.computer).toBeUndefined();
    expect(itx.computers.get("/computers/agents/alice")).toBeDefined();
  });
});
