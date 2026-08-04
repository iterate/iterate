import { describe, expect, it, vi } from "vitest";
import { readGithubTemplateFiles } from "./github-template-artifact.ts";
import {
  GithubTemplateSourceError,
  createGithubTemplateSource,
  type GithubTemplateFile,
  type ResolvedGithubTemplateSource,
} from "./github-template-source.ts";

const COMMIT_SHA = "1".repeat(40);
const MOVED_SHA = "2".repeat(40);
const TREE_SHA = "3".repeat(40);
const FILES: GithubTemplateFile[] = [
  { bytes: new TextEncoder().encode("ok\n"), mode: "100644", path: "worker.ts" },
];
const SOURCE: ResolvedGithubTemplateSource = {
  branch: "main",
  commitSha: COMMIT_SHA,
  owner: "iterate",
  path: "configs/with-voice",
  ref: "main",
  repo: "iterate",
};

function sourceAdapter(
  files: ReturnType<typeof vi.fn> = vi.fn(async () => FILES),
): ReturnType<typeof createGithubTemplateSource> {
  return {
    files,
    resolve: vi.fn(),
  } as ReturnType<typeof createGithubTemplateSource>;
}

function artifacts(head = COMMIT_SHA) {
  const repo = {
    log: vi.fn(async () => [{ hash: head, treeHash: TREE_SHA }]),
    readTree: vi.fn(async () => []),
  };
  let getCalls = 0;
  return {
    binding: {
      delete: vi.fn(async () => true),
      get: vi.fn(async () => {
        getCalls += 1;
        if (getCalls === 1) return repo as unknown as ArtifactsRepo;
        throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      }),
      import: vi.fn(async () => ({}) as ArtifactsCreateRepoResult),
    },
    repo,
  };
}

describe("GitHub template Artifact materialization", () => {
  it("imports a branch server-side, reads its immutable tree, then awaits cleanup", async () => {
    const { binding, repo } = artifacts();
    const adapter = sourceAdapter();

    await expect(
      readGithubTemplateFiles({
        artifacts: binding,
        source: SOURCE,
        sourceAdapter: adapter,
        temporaryArtifactName: "project--config--template-source",
      }),
    ).resolves.toEqual(FILES);

    expect(binding.import).toHaveBeenCalledWith({
      source: {
        branch: "main",
        depth: 1,
        url: "https://github.com/iterate/iterate.git",
      },
      target: { name: "project--config--template-source" },
    });
    expect(repo.log).toHaveBeenCalledWith({ limit: 1, ref: "main" });
    expect(adapter.files).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ rootTreeHash: TREE_SHA }),
    );
    expect(binding.delete).toHaveBeenCalledWith("project--config--template-source");
    expect(binding.get).toHaveBeenCalledTimes(2);
  });

  it("falls back to the immutable GitHub tree when a branch moved after resolution", async () => {
    const { binding } = artifacts(MOVED_SHA);
    const adapter = sourceAdapter();

    await expect(
      readGithubTemplateFiles({
        artifacts: binding,
        source: SOURCE,
        sourceAdapter: adapter,
        temporaryArtifactName: "project--config--template-source",
      }),
    ).resolves.toEqual(FILES);
    expect(adapter.files).toHaveBeenCalledWith(SOURCE);
    expect(binding.delete).toHaveBeenCalledOnce();
  });

  it("cleans the temporary import before propagating a source failure", async () => {
    const { binding } = artifacts();
    const failure = new GithubTemplateSourceError("bad template", { retryable: false });
    const adapter = sourceAdapter(vi.fn(async () => Promise.reject(failure)));

    await expect(
      readGithubTemplateFiles({
        artifacts: binding,
        source: SOURCE,
        sourceAdapter: adapter,
        temporaryArtifactName: "project--config--template-source",
      }),
    ).rejects.toBe(failure);
    expect(binding.delete).toHaveBeenCalledOnce();
    expect(binding.get).toHaveBeenCalledTimes(2);
  });

  it("uses no temporary Artifact for tags and commits", async () => {
    const { binding } = artifacts();
    const adapter = sourceAdapter();

    await expect(
      readGithubTemplateFiles({
        artifacts: binding,
        source: { ...SOURCE, branch: undefined, ref: "v1" },
        sourceAdapter: adapter,
        temporaryArtifactName: "project--config--template-source",
      }),
    ).resolves.toEqual(FILES);
    expect(adapter.files).toHaveBeenCalledWith({ ...SOURCE, branch: undefined, ref: "v1" });
    expect(binding.import).not.toHaveBeenCalled();
    expect(binding.delete).not.toHaveBeenCalled();
  });
});
