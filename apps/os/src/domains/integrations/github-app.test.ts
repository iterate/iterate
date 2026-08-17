import { describe, expect, it, vi } from "vitest";
import { mintGithubRepositoryInstallationToken } from "./github-app.ts";

vi.mock("../secrets/utils.ts", () => ({
  computeSignatureBase64Url: vi.fn().mockResolvedValue("signature"),
}));

describe("mintGithubRepositoryInstallationToken", () => {
  it("resolves a repository installation and exchanges its id for a token", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toMatch(/^Bearer .+\.signature$/);
      if (request.url === "https://api.github.test/repos/iterate/iterate/installation") {
        expect(request.method).toBe("GET");
        return Response.json({ id: 42 });
      }
      if (request.url === "https://api.github.test/app/installations/42/access_tokens") {
        expect(request.method).toBe("POST");
        return Response.json({ token: "installation-token" }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    await expect(
      mintGithubRepositoryInstallationToken({
        apiBase: "https://api.github.test/",
        appId: "123",
        fetcher,
        owner: "iterate",
        privateKeyPem: "test-key",
        repo: "iterate",
      }),
    ).resolves.toBe("installation-token");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid installation lookup response before token exchange", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "42" }));

    await expect(
      mintGithubRepositoryInstallationToken({
        apiBase: "https://api.github.test",
        appId: "123",
        fetcher,
        owner: "iterate",
        privateKeyPem: "test-key",
        repo: "iterate",
      }),
    ).rejects.toThrow("installation lookup returned an invalid response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
