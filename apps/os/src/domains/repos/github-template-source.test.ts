import { InMemoryFs } from "@cloudflare/shell";
import { describe, expect, it, vi } from "vitest";
import {
  GithubTemplateSourceError,
  createGithubTemplateSource,
  isRetryableGithubTemplateSourceError,
  type ResolvedGithubTemplateSource,
} from "./github-template-source.ts";

const COMMIT_SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const CHECKOUT_ROOT = "/checkout";

async function checkout(
  source: ResolvedGithubTemplateSource,
  setup?: (filesystem: InMemoryFs) => Promise<void>,
) {
  const filesystem = new InMemoryFs();
  await filesystem.mkdir(`${CHECKOUT_ROOT}/configs/with-voice/assets`, { recursive: true });
  await filesystem.writeFile(
    `${CHECKOUT_ROOT}/configs/with-voice/worker.ts`,
    "export default {}\n",
  );
  await filesystem.writeFileBytes(
    `${CHECKOUT_ROOT}/configs/with-voice/assets/logo.bin`,
    Uint8Array.from([0, 255, 1, 2]),
  );
  await filesystem.symlink("worker.ts", `${CHECKOUT_ROOT}/configs/with-voice/worker-link`);
  await setup?.(filesystem);
  return { filesystem, headSha: source.commitSha, root: CHECKOUT_ROOT };
}

describe("GitHub template source", () => {
  it("pins the advertised default branch and copies exact subtree bytes and symlinks", async () => {
    const readServerRefs = vi.fn(async () => [
      { oid: COMMIT_SHA, ref: "HEAD", target: "refs/heads/main" },
      { oid: COMMIT_SHA, ref: "refs/heads/main" },
    ]);
    const source = createGithubTemplateSource({ checkout, readServerRefs });

    const resolved = await source.resolve({
      owner: "iterate",
      path: "configs/with-voice",
      repo: "iterate",
    });
    expect(resolved).toEqual({
      commitSha: COMMIT_SHA,
      owner: "iterate",
      path: "configs/with-voice",
      repo: "iterate",
    });
    expect(readServerRefs).toHaveBeenCalledWith("https://github.com/iterate/iterate.git");

    const files = await source.files(resolved);
    expect(files.map(({ mode, path }) => ({ mode, path }))).toEqual([
      { mode: "100644", path: "assets/logo.bin" },
      { mode: "120000", path: "worker-link" },
      { mode: "100644", path: "worker.ts" },
    ]);
    expect(files.find((file) => file.path === "assets/logo.bin")?.bytes).toEqual(
      Uint8Array.from([0, 255, 1, 2]),
    );
    expect(new TextDecoder().decode(files.find((file) => file.path === "worker-link")?.bytes)).toBe(
      "worker.ts",
    );
  });

  it("resolves branches before tags and peels annotated tags", async () => {
    const source = createGithubTemplateSource({
      checkout,
      readServerRefs: async () => [
        { oid: OTHER_SHA, ref: "refs/tags/release", peeled: COMMIT_SHA },
        { oid: COMMIT_SHA, ref: "refs/heads/release" },
        { oid: OTHER_SHA, ref: "refs/tags/tag-only", peeled: COMMIT_SHA },
      ],
    });

    await expect(source.resolve({ owner: "o", ref: "release", repo: "r" })).resolves.toMatchObject({
      commitSha: COMMIT_SHA,
    });
    await expect(source.resolve({ owner: "o", ref: "tag-only", repo: "r" })).resolves.toMatchObject(
      { commitSha: COMMIT_SHA },
    );
  });

  it("accepts a full commit directly and resolves an unadvertised short commit through GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sha: COMMIT_SHA }));
    const source = createGithubTemplateSource({
      checkout,
      fetch: fetcher,
      readServerRefs: async () => [{ oid: OTHER_SHA, ref: "HEAD" }],
    });

    await expect(source.resolve({ owner: "o", ref: COMMIT_SHA, repo: "r" })).resolves.toMatchObject(
      { commitSha: COMMIT_SHA },
    );
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      source.resolve({ owner: "o", ref: COMMIT_SHA.slice(0, 12), repo: "r" }),
    ).resolves.toMatchObject({ commitSha: COMMIT_SHA });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/o/r/commits/${COMMIT_SHA.slice(0, 12)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects missing and non-directory subtrees as terminal source outcomes", async () => {
    const source = createGithubTemplateSource({
      checkout,
      readServerRefs: async () => [{ oid: COMMIT_SHA, ref: "HEAD" }],
    });

    await expect(
      source.files({ commitSha: COMMIT_SHA, owner: "o", path: "missing", repo: "r" }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      source.files({
        commitSha: COMMIT_SHA,
        owner: "o",
        path: "configs/with-voice/worker.ts",
        repo: "r",
      }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("classifies Git smart-HTTP outages as retryable and non-public repos as terminal", async () => {
    for (const [status, retryable] of [
      [401, false],
      [503, true],
      [429, true],
    ] as const) {
      const source = createGithubTemplateSource({
        checkout,
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

  it("keeps a checkout mismatch retryable instead of copying a moved source", async () => {
    const source = createGithubTemplateSource({
      checkout: async (resolved) => ({ ...(await checkout(resolved)), headSha: OTHER_SHA }),
      readServerRefs: async () => [{ oid: COMMIT_SHA, ref: "HEAD" }],
    });

    await expect(source.files({ commitSha: COMMIT_SHA, owner: "o", repo: "r" })).rejects.toSatisfy(
      (error: unknown) => isRetryableGithubTemplateSourceError(error),
    );
  });
});
