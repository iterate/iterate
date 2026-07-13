import { beforeEach, describe, expect, test, vi } from "vitest";
import { assertGithubInstallationTokenMintAuthorized } from "./github-app.ts";
import { lookupConnectionClaim } from "./integration-streams.ts";

vi.mock("./integration-streams.ts", () => ({
  lookupConnectionClaim: vi.fn(),
}));

const platformPrivateKey = { platform: "integrations.github" };

describe("GitHub App installation token mint authorization", () => {
  beforeEach(() => {
    vi.mocked(lookupConnectionClaim).mockReset();
  });

  test("rejects a platform-key mint when another project claims the installation", async () => {
    vi.mocked(lookupConnectionClaim).mockResolvedValue({
      connection: "install-123",
      projectId: "prj_other",
    });

    await expect(
      assertGithubInstallationTokenMintAuthorized({
        installationId: "123",
        privateKey: platformPrivateKey,
        projectId: "prj_requester",
      }),
    ).rejects.toThrow(/installation.*not claimed by.*project/i);
    expect(lookupConnectionClaim).toHaveBeenCalledWith("github", "123");
  });

  test("rejects a platform-key mint when the installation is unclaimed", async () => {
    vi.mocked(lookupConnectionClaim).mockResolvedValue(null);

    await expect(
      assertGithubInstallationTokenMintAuthorized({
        installationId: "123",
        privateKey: platformPrivateKey,
        projectId: "prj_requester",
      }),
    ).rejects.toThrow(/installation.*not claimed by.*project/i);
    expect(lookupConnectionClaim).toHaveBeenCalledWith("github", "123");
  });

  test("accepts a platform-key mint when this project claims the installation", async () => {
    vi.mocked(lookupConnectionClaim).mockResolvedValue({
      connection: "install-123",
      projectId: "prj_requester",
    });

    await expect(
      assertGithubInstallationTokenMintAuthorized({
        installationId: "123",
        privateKey: platformPrivateKey,
        projectId: "prj_requester",
      }),
    ).resolves.toBeUndefined();
    expect(lookupConnectionClaim).toHaveBeenCalledWith("github", "123");
  });

  test("keeps bring-your-own private key material independent of platform claims", async () => {
    await expect(
      assertGithubInstallationTokenMintAuthorized({
        installationId: "123",
        privateKey: "material",
        projectId: "prj_requester",
      }),
    ).resolves.toBeUndefined();
    expect(lookupConnectionClaim).not.toHaveBeenCalled();
  });
});
