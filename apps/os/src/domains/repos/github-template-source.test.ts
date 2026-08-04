import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import {
  GithubTemplateSourceError,
  createBoundedGitHttpClient,
  createGithubTemplateSource,
  isRetryableGithubTemplateSourceError,
} from "./github-template-source.ts";

const COMMIT_SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const ROOT_TREE = "3".repeat(40);
const CONFIGS_TREE = "4".repeat(40);
const TEMPLATE_TREE = "5".repeat(40);
const ASSETS_TREE = "6".repeat(40);

async function blobSha(bytes: Uint8Array | string): Promise<string> {
  return (await git.hashBlob({ object: bytes })).oid;
}

function bytesResponse(bytes: Uint8Array | string): Response {
  return new Response(typeof bytes === "string" ? bytes : Uint8Array.from(bytes).buffer);
}

describe("GitHub template source", () => {
  it("pins the advertised default branch and copies exact subtree bytes and symlinks", async () => {
    const worker = "export default {}\n";
    const link = "worker.ts";
    const logo = Uint8Array.from([0, 255, 1, 2]);
    const workerBlob = await blobSha(worker);
    const linkBlob = await blobSha(link);
    const logoBlob = await blobSha(logo);
    const readServerRefs = vi.fn(async () => [
      { oid: COMMIT_SHA, ref: "HEAD", target: "refs/heads/main" },
      { oid: COMMIT_SHA, ref: "refs/heads/main" },
    ]);
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/worker.ts")) return bytesResponse(worker);
      if (path.endsWith("/worker-link")) return bytesResponse(link);
      if (path.endsWith("/assets/logo.bin")) return bytesResponse(logo);
      return new Response("missing", { status: 404 });
    });
    const trees = new Map<string, unknown>([
      [ROOT_TREE, [{ hash: CONFIGS_TREE, mode: "40000", name: "configs", type: "tree" }]],
      [CONFIGS_TREE, [{ hash: TEMPLATE_TREE, mode: "40000", name: "with-voice", type: "tree" }]],
      [
        TEMPLATE_TREE,
        [
          { hash: ASSETS_TREE, mode: "40000", name: "assets", type: "tree" },
          { hash: linkBlob, mode: "120000", name: "worker-link", type: "symlink" },
          { hash: workerBlob, mode: "100644", name: "worker.ts", type: "blob" },
        ],
      ],
      [ASSETS_TREE, [{ hash: logoBlob, mode: "100644", name: "logo.bin", type: "blob" }]],
    ]);
    const source = createGithubTemplateSource({ fetch: fetcher, readServerRefs });

    const resolved = await source.resolve({
      owner: "iterate",
      path: "configs/with-voice",
      repo: "iterate",
    });
    expect(resolved).toEqual({
      branch: "main",
      commitSha: COMMIT_SHA,
      owner: "iterate",
      path: "configs/with-voice",
      repo: "iterate",
    });
    expect(readServerRefs).toHaveBeenCalledWith("https://github.com/iterate/iterate.git", {
      prefix: "HEAD",
      symrefs: true,
    });

    const files = await source.files(resolved, {
      readTree: async (hash) => trees.get(hash),
      rootTreeHash: ROOT_TREE,
    });
    expect(files.map(({ mode, path }) => ({ mode, path }))).toEqual([
      { mode: "100644", path: "assets/logo.bin" },
      { mode: "120000", path: "worker-link" },
      { mode: "100644", path: "worker.ts" },
    ]);
    expect(files.find((file) => file.path === "assets/logo.bin")?.bytes).toEqual(logo);
    expect(new TextDecoder().decode(files.find((file) => file.path === "worker-link")?.bytes)).toBe(
      link,
    );
  });

  it("resolves branches before tags and peels annotated tags", async () => {
    const readServerRefs = vi.fn(
      async (_url: string, _query: { peelTags?: boolean; prefix: string; symrefs?: boolean }) => [
        { oid: OTHER_SHA, ref: "refs/tags/release", peeled: COMMIT_SHA },
        { oid: COMMIT_SHA, ref: "refs/heads/release" },
        { oid: OTHER_SHA, ref: "refs/tags/tag-only", peeled: COMMIT_SHA },
      ],
    );
    const source = createGithubTemplateSource({
      readServerRefs,
    });

    await expect(source.resolve({ owner: "o", ref: "release", repo: "r" })).resolves.toMatchObject({
      branch: "release",
      commitSha: COMMIT_SHA,
    });
    const tag = await source.resolve({ owner: "o", ref: "tag-only", repo: "r" });
    expect(tag).toMatchObject({ commitSha: COMMIT_SHA });
    expect(tag).not.toHaveProperty("branch");
    expect(readServerRefs.mock.calls.map(([, query]) => query)).toEqual([
      { prefix: "refs/heads/release" },
      { prefix: "refs/heads/tag-only" },
      { peelTags: true, prefix: "refs/tags/tag-only" },
    ]);
  });

  it("accepts a full commit without ref discovery and resolves an unadvertised short commit", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sha: COMMIT_SHA }));
    const readServerRefs = vi.fn(async () => [{ oid: OTHER_SHA, ref: "HEAD" }]);
    const source = createGithubTemplateSource({ fetch: fetcher, readServerRefs });

    await expect(source.resolve({ owner: "o", ref: COMMIT_SHA, repo: "r" })).resolves.toMatchObject(
      { commitSha: COMMIT_SHA },
    );
    expect(readServerRefs).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      source.resolve({ owner: "o", ref: COMMIT_SHA.slice(0, 12), repo: "r" }),
    ).resolves.toMatchObject({ commitSha: COMMIT_SHA });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/o/r/commits/${COMMIT_SHA.slice(0, 12)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses the public GitHub tree fallback for tag and commit sources", async () => {
    const content = "tagged\n";
    const sha = await blobSha(content);
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/git/trees/")
        ? Response.json({
            tree: [
              { mode: "40000", path: "template", sha: OTHER_SHA, type: "tree" },
              {
                mode: "100644",
                path: "template/value.txt",
                sha,
                size: content.length,
                type: "blob",
              },
            ],
            truncated: false,
          })
        : bytesResponse(content),
    );
    const source = createGithubTemplateSource({ fetch: fetcher, readServerRefs: async () => [] });

    await expect(
      source.files({ commitSha: COMMIT_SHA, owner: "o", path: "template", ref: "v1", repo: "r" }),
    ).resolves.toEqual([
      { bytes: new TextEncoder().encode(content), mode: "100644", path: "value.txt" },
    ]);
  });

  it("rejects missing and non-directory subtrees as terminal source outcomes", async () => {
    const source = createGithubTemplateSource({ readServerRefs: async () => [] });
    const reader = {
      readTree: async () => [{ hash: OTHER_SHA, mode: "100644", name: "file", type: "blob" }],
      rootTreeHash: ROOT_TREE,
    };

    await expect(
      source.files({ commitSha: COMMIT_SHA, owner: "o", path: "missing", repo: "r" }, reader),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      source.files({ commitSha: COMMIT_SHA, owner: "o", path: "file", repo: "r" }, reader),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("classifies Git smart-HTTP outages as retryable and non-public repos as terminal", async () => {
    for (const [status, retryable] of [
      [401, false],
      [503, true],
      [429, true],
    ] as const) {
      const source = createGithubTemplateSource({
        readServerRefs: async () => {
          throw { code: "HttpError", data: { statusCode: status } };
        },
      });
      const error = await source
        .resolve({ owner: "o", repo: "r" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GithubTemplateSourceError);
      expect(error).toMatchObject({ retryable });
    }
  });

  it("rejects an oversized ref advertisement instead of retaining it", async () => {
    const client = createBoundedGitHttpClient(async () =>
      bytesResponse(new Uint8Array(2 * 1024 * 1024 + 1)),
    );
    await expect(client.request({ url: "https://github.com/o/r.git" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("keeps a raw blob mismatch retryable instead of copying inconsistent bytes", async () => {
    const source = createGithubTemplateSource({
      fetch: async () => bytesResponse("wrong"),
      readServerRefs: async () => [],
    });

    await expect(
      source.files(
        { commitSha: COMMIT_SHA, owner: "o", repo: "r" },
        {
          readTree: async () => [
            { hash: OTHER_SHA, mode: "100644", name: "value.txt", type: "blob" },
          ],
          rootTreeHash: ROOT_TREE,
        },
      ),
    ).rejects.toSatisfy((error: unknown) => isRetryableGithubTemplateSourceError(error));
  });
});
