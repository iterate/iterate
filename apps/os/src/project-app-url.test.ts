import { beforeEach, describe, expect, it, vi } from "vitest";

const directoryGet = vi.hoisted(() => vi.fn());

vi.mock("./env.ts", () => ({
  itxEnv: {
    APP_CONFIG: JSON.stringify({
      baseUrl: "https://os.iterate-preview-3.com",
      openAiApiKey: "test-key",
      projectHostnameBases: ["iterate-preview-3.app"],
    }),
    PROJECT_DIRECTORY: { get: directoryGet },
  },
  workerVersion: () => "test-version",
}));

const { ProjectRpcTarget } = await import("./rpc-targets.ts");

describe("ProjectRpcTarget appUrl", () => {
  beforeEach(() => {
    directoryGet.mockReset();
    directoryGet.mockResolvedValue({
      id: "prj_preview",
      name: "Preview project",
      organizationId: null,
      slug: "demo",
    });
  });

  it("builds a named app URL in the current deployment", async () => {
    const target = new ProjectRpcTarget({
      auth: { assertCanAccessProject: vi.fn() },
      capabilityHost: { path: "/" },
      ctx: {},
      streamContext: { kind: "scope", scopePath: "/" },
      projectId: "prj_preview",
    } as never);

    await expect(target.appUrl("docs")).resolves.toBe("https://docs--demo.iterate-preview-3.app");
    expect(directoryGet).toHaveBeenCalledWith("project:prj_preview", "json");
  });
});
