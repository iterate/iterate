import { beforeEach, describe, expect, it, vi } from "vitest";

const secretCreate = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    SECRET: {
      getByName: () => ({ create: secretCreate }),
    },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("SecretRpcTarget create", () => {
  beforeEach(() => {
    secretCreate.mockReset();
    vi.restoreAllMocks();
  });

  it("replays one idempotent create after a Secret Durable Object lifecycle reset", async () => {
    const reset = Object.assign(
      new Error(
        "Durable Object storage operation exceeded timeout which caused object to be reset.",
      ),
      { durableObjectReset: true },
    );
    secretCreate.mockRejectedValueOnce(reset).mockResolvedValueOnce(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);
    const input = {
      egress: { urls: ["https://example.com"] },
      material: { token: "secret" },
    };

    await expect(
      target.secrets.get("/secrets/connections/example").create(input),
    ).resolves.toBeDefined();
    expect(secretCreate).toHaveBeenCalledTimes(2);
    expect(secretCreate).toHaveBeenNthCalledWith(1, input);
    expect(secretCreate).toHaveBeenNthCalledWith(2, input);
    expect(info).toHaveBeenCalledWith("secret create retrying after Durable Object reset", {
      error: reset,
      path: "/secrets/connections/example",
      projectId: "prj_preview",
    });
  });

  it("does not replay an application rejection", async () => {
    const applicationError = new Error("secret already created with a different egress policy");
    secretCreate.mockRejectedValueOnce(applicationError);
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(
      target.secrets.get("/secrets/connections/example").create({
        egress: { urls: ["https://example.com"] },
        material: { token: "secret" },
      }),
    ).rejects.toBe(applicationError);
    expect(secretCreate).toHaveBeenCalledOnce();
  });
});
