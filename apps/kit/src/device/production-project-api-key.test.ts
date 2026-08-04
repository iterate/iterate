import { describe, expect, test, vi } from "vitest";
import { resolveProductionProjectApiKey } from "./production-project-api-key.ts";

describe("production project API-key resolution", () => {
  test("uses an explicitly supplied project key without exercising admin authority", async () => {
    /*
     * A project key recovered from the physical device is the narrowest
     * authority available. The unattended harness must not silently involve
     * an admin session merely because Doppler also supplied one.
     */
    const reveal = vi.fn();

    await expect(
      resolveProductionProjectApiKey(
        {
          adminApiSecret: "admin_unused",
          baseUrl: "https://os.iterate.com",
          projectApiKey: "itxk_device_key",
          projectId: "prj_test",
        },
        reveal,
      ),
    ).resolves.toBe("itxk_device_key");
    expect(reveal).not.toHaveBeenCalled();
  });

  test("uses admin authority only for an in-memory project-key pairing ceremony", async () => {
    /*
     * Re-reading the ESP configuration partition resets a healthy board and
     * can require manual ROM-loader entry. A Doppler-backed proof already has
     * deployment authority, so it may reveal the deliberately readable born
     * key in memory, dispose that admin session, and then measure the real
     * project-secret ingress. The callback seam proves exactly what context is
     * supplied without putting either secret in output or artifacts.
     */
    const reveal = vi.fn(async () => "itxk_revealed_key");

    await expect(
      resolveProductionProjectApiKey(
        {
          adminApiSecret: "admin_secret",
          baseUrl: "https://os.iterate.com",
          projectId: "prj_test",
        },
        reveal,
      ),
    ).resolves.toBe("itxk_revealed_key");
    expect(reveal).toHaveBeenCalledWith({
      adminApiSecret: "admin_secret",
      baseUrl: "https://os.iterate.com",
      projectId: "prj_test",
    });
  });

  test("fails closed when project-key revelation returns an unexpected shape", async () => {
    const reveal = vi.fn(async () => "not-a-project-key");

    await expect(
      resolveProductionProjectApiKey(
        {
          adminApiSecret: "admin_secret",
          baseUrl: "https://os.iterate.com",
          projectId: "prj_test",
        },
        reveal,
      ),
    ).rejects.toThrow("absent or malformed");
  });
});
