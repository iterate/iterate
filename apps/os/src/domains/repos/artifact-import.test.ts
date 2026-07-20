import { describe, expect, test, vi } from "vitest";
import { importGithubArtifact } from "./artifact-import.ts";

function fakeArtifacts() {
  const artifact = {
    createToken: vi.fn(async () => ({
      id: "read-token-id",
      plaintext: "read-token?expires=soon",
    })),
    name: "target",
    remote: "https://artifacts.example/git/target.git",
    revokeToken: vi.fn(async () => true),
  };
  return {
    artifact,
    get: vi.fn(async () => artifact),
    import: vi.fn(async () => ({ name: "target" })),
  } as unknown as Artifacts & { artifact: typeof artifact };
}

const COMMIT_OID = "0123456789abcdef0123456789abcdef01234567";

function packetLine(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

function refAdvertisement(branch = "main") {
  return new Response(
    `${packetLine("# service=git-upload-pack\n")}0000${packetLine(
      `${COMMIT_OID} HEAD\0symref=HEAD:refs/heads/${branch}\n`,
    )}${packetLine(`${COMMIT_OID} refs/heads/${branch}\n`)}0000`,
    { headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
  );
}

describe("importGithubArtifact", () => {
  test("imports a canonical public GitHub URL at the requested depth", async () => {
    const artifacts = fakeArtifacts();

    const fetchRemote = vi.fn(async () => refAdvertisement());
    await expect(
      importGithubArtifact(
        artifacts,
        {
          branch: "main",
          depth: 1,
          name: "project--repo",
          owner: "iterate",
          repo: "iterate",
        },
        { fetchRemote },
      ),
    ).resolves.toEqual({ commitOid: COMMIT_OID });

    expect(artifacts.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        depth: 1,
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "project--repo" },
    });
    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
    expect(fetchRemote).toHaveBeenCalledWith(
      "https://artifacts.example/git/target.git/info/refs?service=git-upload-pack",
      {
        headers: {
          accept: "application/x-git-upload-pack-advertisement",
          authorization: `Basic ${btoa("x:read-token")}`,
        },
      },
    );
    expect(artifacts.artifact.createToken).toHaveBeenCalledWith("read", 60);
    expect(artifacts.artifact.revokeToken).toHaveBeenCalledWith("read-token-id");
  });

  test("accepts an existing deterministic target on recovery", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { code: "ALREADY_EXISTS" }),
    );

    await importGithubArtifact(
      artifacts,
      {
        branch: "main",
        depth: 1,
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      },
      { fetchRemote: async () => refAdvertisement() },
    );

    expect(artifacts.get).toHaveBeenCalledWith("project--repo");
  });

  test("waits boundedly for an import already in progress", async () => {
    const artifacts = fakeArtifacts();
    const sleep = vi.fn(async () => undefined);
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );
    vi.mocked(artifacts.get)
      .mockRejectedValueOnce(
        Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
      )
      .mockResolvedValueOnce(artifacts.artifact as never);

    await importGithubArtifact(
      artifacts,
      {
        branch: "main",
        depth: 1,
        name: "project--repo",
        owner: "iterate",
        repo: "iterate",
      },
      {
        fetchRemote: async () => refAdvertisement(),
        pollAttempts: 2,
        pollIntervalMs: 7,
        sleep,
      },
    );

    expect(artifacts.get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
  });

  test("fails explicitly when an in-progress import never completes", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );
    vi.mocked(artifacts.get).mockRejectedValue(
      Object.assign(new Error("import in progress"), { code: "IMPORT_IN_PROGRESS" }),
    );

    await expect(
      importGithubArtifact(
        artifacts,
        {
          branch: "main",
          depth: 1,
          name: "project--repo",
          owner: "iterate",
          repo: "iterate",
        },
        { pollAttempts: 2, pollIntervalMs: 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow("Timed out waiting for Cloudflare Artifacts");
    expect(artifacts.get).toHaveBeenCalledTimes(2);
  });

  test("does not hide import failures", async () => {
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.import).mockRejectedValueOnce(
      Object.assign(new Error("private repository"), { code: "REMOTE_AUTH_REQUIRED" }),
    );

    await expect(
      importGithubArtifact(artifacts, {
        branch: "main",
        depth: 1,
        name: "project--repo",
        owner: "iterate",
        repo: "private",
      }),
    ).rejects.toThrow("private repository");
    expect(artifacts.get).not.toHaveBeenCalled();
  });

  test("fails if the imported branch is not advertised and still revokes the token", async () => {
    const artifacts = fakeArtifacts();

    await expect(
      importGithubArtifact(
        artifacts,
        {
          branch: "main",
          depth: 1,
          name: "project--repo",
          owner: "iterate",
          repo: "iterate",
        },
        { fetchRemote: async () => refAdvertisement("other") },
      ),
    ).rejects.toThrow('did not advertise branch "main"');

    expect(artifacts.artifact.revokeToken).toHaveBeenCalledWith("read-token-id");
  });
});
