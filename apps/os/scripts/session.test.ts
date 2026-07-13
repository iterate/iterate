import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { create } from "./session.ts";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("operator session CLI", () => {
  it("uses the selected environment URL and admin secret to mint a project session", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "preview-admin-secret");
    vi.stubEnv("OPERATOR_IDENTITY", "preview-support-engineer");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        browserUrl: "https://preview.example.test/api/operator-sessions/redeem#token=grant",
        expiresAt: "2030-01-01T00:00:00.000Z",
        kind: "project",
        project: { id: "prj_test", slug: "test" },
        token: "grant",
      }),
    );
    const output = vi.spyOn(console, "info").mockImplementation(() => {});

    await create({ project: "test", ttlSeconds: 600 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://preview.example.test/api/operator-sessions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer preview-admin-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "project",
      operatorId: "preview-support-engineer",
      project: "test",
      ttlSeconds: 600,
    });
    expect(output).toHaveBeenCalledWith(
      "https://preview.example.test/api/operator-sessions/redeem#token=grant",
    );
  });

  it("requires exactly one authority mode", async () => {
    await expect(create({ admin: true, project: "test" })).rejects.toThrow("exactly one");
    await expect(create({ operator: "support@example.test" })).rejects.toThrow("exactly one");
  });

  it("uses an explicit operator identity for audit attribution", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "preview-admin-secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        browserUrl: "https://preview.example.test/api/operator-sessions/redeem#token=grant",
        expiresAt: "2030-01-01T00:00:00.000Z",
        kind: "project",
        project: { id: "prj_test", slug: "test" },
        token: "grant",
      }),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});

    await create({ operator: "support@example.test", project: "test" });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operatorId: "support@example.test",
    });
  });

  it("fails before the network when the selected environment has no admin secret", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "");
    await expect(create({ project: "test" })).rejects.toThrow("APP_CONFIG_ADMIN_API_SECRET");
  });

  it("opens browser sessions through the Windows URL handler", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "preview-admin-secret");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        browserUrl: "https://preview.example.test/api/operator-sessions/redeem#token=grant",
        expiresAt: "2030-01-01T00:00:00.000Z",
        kind: "admin",
        project: null,
        token: "grant",
      }),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});

    await create({ admin: true, open: true, operator: "operator:test" });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "rundll32.exe",
      [
        "url.dll,FileProtocolHandler",
        "https://preview.example.test/api/operator-sessions/redeem#token=grant",
      ],
      { stdio: "inherit" },
    );
  });
});
