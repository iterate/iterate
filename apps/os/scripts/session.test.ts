import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "./session.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("operator session CLI", () => {
  it("uses the selected environment URL and admin secret to mint a project session", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "preview-admin-secret");
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

    await create({ as: "support@example.test", project: "test", ttlSeconds: 600 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://preview.example.test/api/operator-sessions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer preview-admin-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "project",
      project: "test",
      subject: "support@example.test",
      ttlSeconds: 600,
    });
    expect(output).toHaveBeenCalledWith(
      "https://preview.example.test/api/operator-sessions/redeem#token=grant",
    );
  });

  it("requires an explicit project identity and exactly one authority mode", async () => {
    await expect(create({ project: "test" })).rejects.toThrow("require --as");
    await expect(create({ admin: true, project: "test" })).rejects.toThrow("exactly one");
    await expect(create({ as: "support@example.test" })).rejects.toThrow("exactly one");
  });

  it("fails before the network when the selected environment has no admin secret", async () => {
    vi.stubEnv("APP_CONFIG_BASE_URL", "https://preview.example.test");
    vi.stubEnv("APP_CONFIG_ADMIN_API_SECRET", "");
    await expect(create({ as: "support@example.test", project: "test" })).rejects.toThrow(
      "APP_CONFIG_ADMIN_API_SECRET",
    );
  });
});
