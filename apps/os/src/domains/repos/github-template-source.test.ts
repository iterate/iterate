import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import {
  GithubTemplateSourceError,
  createGithubTemplateSource,
  isRetryableGithubTemplateSourceError,
  type GithubTemplateRequest,
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

function pktLine(value: string): string {
  const length = new TextEncoder().encode(value).byteLength + 4;
  return `${length.toString(16).padStart(4, "0")}${value}`;
}

function gitRefsResponse(input: {
  branches?: Record<string, string>;
  defaultBranch?: string;
  tags?: Record<string, { oid: string; peeled?: string }>;
}): Response {
  const branches = input.branches ?? { main: COMMIT_SHA };
  const defaultBranch = input.defaultBranch ?? "main";
  const head = branches[defaultBranch];
  if (head === undefined) throw new Error("The test advertisement needs its default branch.");
  const refs = [
    pktLine(`${head} HEAD\0symref=HEAD:refs/heads/${defaultBranch}\n`),
    ...Object.entries(branches).map(([branch, oid]) => pktLine(`${oid} refs/heads/${branch}\n`)),
    ...Object.entries(input.tags ?? {}).flatMap(([tag, { oid, peeled }]) => [
      pktLine(`${oid} refs/tags/${tag}\n`),
      ...(peeled === undefined ? [] : [pktLine(`${peeled} refs/tags/${tag}^{}\n`)]),
    ]),
  ];
  return new Response(`${pktLine("# service=git-upload-pack\n")}0000${refs.join("")}0000`, {
    headers: { "content-type": "application/x-git-upload-pack-advertisement" },
  });
}

describe("GitHub template source", () => {
  it("pins the advertised default branch and copies exact subtree bytes and symlinks", async () => {
    const worker = "export default {}\n";
    const link = "worker.ts";
    const logo = Uint8Array.from([0, 255, 1, 2]);
    const workerBlob = await blobSha(worker);
    const linkBlob = await blobSha(link);
    const logoBlob = await blobSha(logo);
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.includes("/info/refs?service=git-upload-pack")) return gitRefsResponse({});
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
    const source = createGithubTemplateSource({ fetch: fetcher });

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
    expect(fetcher).toHaveBeenCalledWith(
      "https://github.com/iterate/iterate.git/info/refs?service=git-upload-pack",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );

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

  it("resolves branches before tags and commits", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      gitRefsResponse({
        branches: { main: OTHER_SHA, release: COMMIT_SHA },
        tags: {
          "annotated-tag": { oid: ROOT_TREE, peeled: COMMIT_SHA },
          "tag-only": { oid: OTHER_SHA },
        },
      }),
    );
    const source = createGithubTemplateSource({ fetch: fetcher });

    await expect(source.resolve({ owner: "o", ref: "release", repo: "r" })).resolves.toMatchObject({
      branch: "release",
      commitSha: COMMIT_SHA,
    });
    const tag = await source.resolve({ owner: "o", ref: "tag-only", repo: "r" });
    expect(tag).toMatchObject({ commitSha: OTHER_SHA });
    expect(tag).not.toHaveProperty("branch");
    await expect(
      source.resolve({ owner: "o", ref: "annotated-tag", repo: "r" }),
    ).resolves.toMatchObject({ commitSha: COMMIT_SHA });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("projects a creation request onto the strict resolved-source fact", async () => {
    const source = createGithubTemplateSource({
      fetch: async () => gitRefsResponse({ branches: { main: COMMIT_SHA } }),
    });

    const resolved = await source.resolve({
      type: "github-public-template",
      owner: "iterate",
      ref: "main",
      repo: "iterate",
    } as GithubTemplateRequest);

    expect(resolved).toEqual({
      branch: "main",
      commitSha: COMMIT_SHA,
      owner: "iterate",
      ref: "main",
      repo: "iterate",
    });
    expect(resolved).not.toHaveProperty("type");
  });

  it("accepts a full commit without discovery and rejects an unadvertised short commit", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => gitRefsResponse({}));
    const source = createGithubTemplateSource({ fetch: fetcher });

    await expect(source.resolve({ owner: "o", ref: COMMIT_SHA, repo: "r" })).resolves.toMatchObject(
      { commitSha: COMMIT_SHA },
    );
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      source.resolve({ owner: "o", ref: COMMIT_SHA.slice(0, 12), repo: "r" }),
    ).rejects.toThrow("full 40-character commit SHA");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("copies tag and commit sources from an imported immutable Artifact tree", async () => {
    const content = "tagged\n";
    const sha = await blobSha(content);
    const fetcher = vi.fn<typeof fetch>(async () => bytesResponse(content));
    const source = createGithubTemplateSource({ fetch: fetcher });

    await expect(
      source.files(
        { commitSha: COMMIT_SHA, owner: "o", path: "template", ref: "v1", repo: "r" },
        {
          readTree: async (hash) =>
            hash === ROOT_TREE
              ? [{ hash: TEMPLATE_TREE, mode: "40000", name: "template", type: "tree" }]
              : [{ hash: sha, mode: "100644", name: "value.txt", type: "blob" }],
          rootTreeHash: ROOT_TREE,
        },
      ),
    ).resolves.toEqual([
      { bytes: new TextEncoder().encode(content), mode: "100644", path: "value.txt" },
    ]);
  });

  it("rejects missing and non-directory subtrees as terminal source outcomes", async () => {
    const source = createGithubTemplateSource();
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

  it("classifies Git transport outages as retryable and non-public repos as terminal", async () => {
    for (const [status, retryable] of [
      [401, false],
      [503, true],
      [429, true],
    ] as const) {
      const source = createGithubTemplateSource({
        fetch: async () => new Response(null, { status }),
      });
      const error = await source
        .resolve({ owner: "o", repo: "r" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GithubTemplateSourceError);
      expect(error).toMatchObject({ retryable });
    }
  });

  it("rejects an oversized ref response instead of retaining it", async () => {
    const source = createGithubTemplateSource({
      fetch: async () =>
        new Response(new Uint8Array(1024 * 1024 + 1), {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        }),
    });
    await expect(source.resolve({ owner: "o", repo: "r" })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("keeps a raw blob mismatch retryable instead of copying inconsistent bytes", async () => {
    const source = createGithubTemplateSource({
      fetch: async () => bytesResponse("wrong"),
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
