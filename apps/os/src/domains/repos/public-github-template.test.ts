import { describe, expect, it, vi } from "vitest";
import { downloadPublicGithubTemplate } from "./public-github-template.ts";
import { RetryableRepoCreationError } from "./utils.ts";

const COMMIT_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);

describe("downloadPublicGithubTemplate", () => {
  it("copies one public folder as sorted text files from a single commit", async () => {
    const githubFetch = vi.fn(async (url: string) => {
      if (url.includes("/commits/feature%2Fvoice")) {
        return jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA });
      }
      if (url.includes(`/git/trees/${TREE_SHA}`)) {
        return jsonResponse({
          tree: [
            { mode: "040000", path: "configs", type: "tree" },
            { mode: "040000", path: "configs/with-voice", type: "tree" },
            {
              mode: "100644",
              path: "configs/with-voice/worker.ts",
              size: 6,
              type: "blob",
            },
            { mode: "100644", path: "README.md", size: 7, type: "blob" },
            {
              mode: "100644",
              path: "configs/with-voice/AGENTS.md",
              size: 7,
              type: "blob",
            },
          ],
          truncated: false,
        });
      }
      if (url.endsWith(`/${COMMIT_SHA}/configs/with-voice/AGENTS.md`)) {
        return new Response("agents\n");
      }
      if (url.endsWith(`/${COMMIT_SHA}/configs/with-voice/worker.ts`)) {
        return new Response("worker");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      downloadPublicGithubTemplate(
        {
          owner: "iterate",
          path: "configs/with-voice",
          ref: "feature/voice",
          repo: "iterate",
        },
        githubFetch,
      ),
    ).resolves.toEqual([
      { content: "agents\n", path: "AGENTS.md" },
      { content: "worker", path: "worker.ts" },
    ]);
    expect(githubFetch).toHaveBeenCalledTimes(4);
  });

  it("uses HEAD and copies the repository root when ref and path are omitted", async () => {
    const githubFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/commits/HEAD")) {
        return jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA });
      }
      if (url.includes(`/git/trees/${TREE_SHA}`)) {
        return jsonResponse({
          tree: [{ mode: "100644", path: "worker.ts", size: 6, type: "blob" }],
          truncated: false,
        });
      }
      return new Response("worker");
    });

    await expect(
      downloadPublicGithubTemplate({ owner: "iterate", repo: "config" }, githubFetch),
    ).resolves.toEqual([{ content: "worker", path: "worker.ts" }]);
  });

  it("rejects a truncated tree instead of silently copying only part of it", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA }))
      .mockResolvedValueOnce(jsonResponse({ tree: [], truncated: true }));

    await expect(
      downloadPublicGithubTemplate({ owner: "iterate", repo: "huge" }, githubFetch),
    ).rejects.toThrow("tree is too large");
  });

  it("rejects non-text files because the bootstrap file structure stores strings", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [{ mode: "100644", path: "image.png", size: 2, type: "blob" }],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe])));

    await expect(
      downloadPublicGithubTemplate({ owner: "iterate", repo: "binary" }, githubFetch),
    ).rejects.toThrow("is not UTF-8 text");
  });

  it("classifies GitHub throttling as retryable", async () => {
    const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));

    const error = await downloadPublicGithubTemplate(
      { owner: "iterate", repo: "rate-limited" },
      githubFetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableRepoCreationError);
  });

  it("classifies an interrupted response body as retryable", async () => {
    const githubFetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("connection closed"));
          },
        }),
      ),
    );

    const error = await downloadPublicGithubTemplate(
      { owner: "iterate", repo: "interrupted" },
      githubFetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableRepoCreationError);
  });

  it("trusts the commit-pinned body instead of GitHub's advisory tree size", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [{ mode: "100644", path: "worker.ts", size: 1, type: "blob" }],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(new Response("worker"));

    await expect(
      downloadPublicGithubTemplate({ owner: "iterate", repo: "config" }, githubFetch),
    ).resolves.toEqual([{ content: "worker", path: "worker.ts" }]);
  });

  it("stops reading a file response at the hard byte limit", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ commit: { tree: { sha: TREE_SHA } }, sha: COMMIT_SHA }))
      .mockResolvedValueOnce(
        jsonResponse({
          tree: [{ mode: "100644", path: "worker.ts", size: 1, type: "blob" }],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1)));

    await expect(
      downloadPublicGithubTemplate({ owner: "iterate", repo: "oversized" }, githubFetch),
    ).rejects.toThrow("more than 2097152 bytes");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
