import { describe, expect, it, vi } from "vitest";

vi.mock("./env.ts", () => ({
  itxEnv: {},
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
  it("trusts an agent scope with the full Computer catalog", () => {
    const itx = projectAt("/agents/alice");

    expect(itx.computers.get("/computers/agents/bob")).toBeDefined();
    const ownComputer = itx.agentComputer;
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

    expect(itx.computers.get("/computers/agents/alice")).toBeDefined();
  });
});
