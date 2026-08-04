import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactWriteToken: vi.fn(async () => "minted-token"),
  getOrCreateArtifact: vi.fn(),
  readFiles: vi.fn(),
  seedArtifactRepo: vi.fn(),
  sourceAdapter: { resolve: vi.fn() },
}));

vi.mock("../../lib/step-timing.ts", () => ({
  timedStep: async (
    _span: string,
    _context: Record<string, unknown>,
    _step: string,
    operation: () => Promise<unknown>,
  ) => await operation(),
}));
vi.mock("./artifact-creation.ts", () => ({
  getOrCreateArtifact: mocks.getOrCreateArtifact,
}));
vi.mock("./artifact-seeding.ts", () => ({
  artifactWriteToken: mocks.artifactWriteToken,
  seedArtifactRepo: mocks.seedArtifactRepo,
}));
vi.mock("./github-template-artifact.ts", () => ({
  readGithubTemplateFiles: mocks.readFiles,
}));
vi.mock("./github-template-source.ts", () => ({
  createGithubTemplateSource: () => mocks.sourceAdapter,
}));

const { createGithubTemplateArtifact } = await import("./github-template-creation.ts");

const source = {
  branch: "default-configs",
  commitSha: "a".repeat(40),
  owner: "iterate",
  path: "configs/with-voice",
  ref: "default-configs",
  repo: "iterate",
};
const baseInput = {
  artifactName: "prj_test--config",
  artifacts: {} as Artifacts,
  artifactsAccountId: "account",
  artifactsNamespace: "namespace",
  projectId: "prj_test",
  repoPath: "/repos/config",
  source,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrCreateArtifact.mockResolvedValue({
    initialWriteToken: "initial-token",
    lastPushAt: null,
  });
  mocks.readFiles.mockResolvedValue([
    { bytes: new Uint8Array([1, 2, 3]), mode: "100644", path: "worker.ts" },
  ]);
  mocks.seedArtifactRepo.mockResolvedValue({ commitOid: "seed-oid", contentHash: "hash" });
});

describe("createGithubTemplateArtifact", () => {
  it("materializes the immutable source into the known Artifact", async () => {
    const onSeeded = vi.fn();

    await expect(createGithubTemplateArtifact({ ...baseInput, onSeeded })).resolves.toEqual({
      artifactName: baseInput.artifactName,
      defaultBranch: "main",
      remote: "https://account.artifacts.cloudflare.net/git/namespace/prj_test--config.git",
    });

    expect(mocks.readFiles).toHaveBeenCalledWith({
      artifacts: baseInput.artifacts,
      source,
      sourceAdapter: mocks.sourceAdapter,
      temporaryArtifactName: "prj_test--config--template-source",
    });
    expect(mocks.seedArtifactRepo).toHaveBeenCalledWith({
      branch: "main",
      files: [{ content: new Uint8Array([1, 2, 3]), mode: "100644", path: "worker.ts" }],
      remote: "https://account.artifacts.cloudflare.net/git/namespace/prj_test--config.git",
      token: "initial-token",
    });
    expect(mocks.artifactWriteToken).not.toHaveBeenCalled();
    expect(onSeeded).toHaveBeenCalledWith({ commitOid: "seed-oid", contentHash: "hash" });
  });

  it("leaves an already-pushed Artifact untouched", async () => {
    mocks.getOrCreateArtifact.mockResolvedValue({
      initialWriteToken: null,
      lastPushAt: "2026-08-04T00:00:00.000Z",
    });

    await createGithubTemplateArtifact(baseInput);

    expect(mocks.readFiles).not.toHaveBeenCalled();
    expect(mocks.seedArtifactRepo).not.toHaveBeenCalled();
    expect(mocks.artifactWriteToken).not.toHaveBeenCalled();
  });
});
