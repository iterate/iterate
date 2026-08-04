import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GithubTemplateSourceError,
  createGithubTemplateSource,
  isRetryableGithubTemplateSourceError,
} from "./github-template-source.ts";

const COMMIT_SHA = "1".repeat(40);
const ROOT_TREE_SHA = "2".repeat(40);
const CONFIGS_TREE_SHA = "3".repeat(40);
const VOICE_TREE_SHA = "4".repeat(40);

function blobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe("GitHub template source", () => {
  it("pins the default branch, selects a subtree, and downloads exact blob bytes", async () => {
    const worker = new TextEncoder().encode("export default {};\n");
    const logo = Uint8Array.from([0, 255, 1, 2]);
    const link = new TextEncoder().encode("README.md");
    const workerSha = blobSha(worker);
    const logoSha = blobSha(logo);
    const linkSha = blobSha(link);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      const route = `${url.pathname}${url.search}`;
      if (route === "/repos/iterate/iterate") return json({ default_branch: "main" });
      if (route === "/repos/iterate/iterate/commits/main") {
        return json({ commit: { tree: { sha: ROOT_TREE_SHA } }, sha: COMMIT_SHA });
      }
      if (route === `/repos/iterate/iterate/git/trees/${ROOT_TREE_SHA}`) {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "040000", path: "configs", sha: CONFIGS_TREE_SHA, type: "tree" }],
          truncated: false,
        });
      }
      if (route === `/repos/iterate/iterate/git/trees/${CONFIGS_TREE_SHA}`) {
        return json({
          sha: CONFIGS_TREE_SHA,
          tree: [{ mode: "040000", path: "with-voice", sha: VOICE_TREE_SHA, type: "tree" }],
          truncated: false,
        });
      }
      if (route === `/repos/iterate/iterate/git/trees/${VOICE_TREE_SHA}?recursive=1`) {
        return json({
          sha: VOICE_TREE_SHA,
          tree: [
            {
              mode: "100644",
              path: "worker.ts",
              sha: workerSha,
              size: worker.byteLength,
              type: "blob",
            },
            {
              mode: "100644",
              path: "assets/logo.bin",
              sha: logoSha,
              size: logo.byteLength,
              type: "blob",
            },
            {
              mode: "120000",
              path: "AGENTS.md",
              sha: linkSha,
              size: link.byteLength,
              type: "blob",
            },
          ],
          truncated: false,
        });
      }
      if (url.pathname.endsWith(`/git/blobs/${workerSha}`)) return new Response(worker);
      if (url.pathname.endsWith(`/git/blobs/${logoSha}`)) return new Response(logo);
      if (url.pathname.endsWith(`/git/blobs/${linkSha}`)) return new Response(link);
      return new Response("not found", { status: 404 });
    });
    const source = createGithubTemplateSource({
      clientId: "client-id",
      clientSecret: "client-secret",
      fetch: fetcher,
    });

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
      treeSha: ROOT_TREE_SHA,
    });
    const files = await source.files(resolved);

    expect(files.map(({ mode, path }) => ({ mode, path }))).toEqual([
      { mode: "120000", path: "AGENTS.md" },
      { mode: "100644", path: "assets/logo.bin" },
      { mode: "100644", path: "worker.ts" },
    ]);
    expect(files.find((file) => file.path === "assets/logo.bin")?.bytes).toEqual(logo);
    const firstHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(firstHeaders.get("authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
    const blobCall = fetcher.mock.calls.find(([input]) =>
      requestUrl(input).pathname.includes("/git/blobs/"),
    );
    expect(new Headers(blobCall?.[1]?.headers).get("accept")).toBe(
      "application/vnd.github.raw+json",
    );
  });

  it("walks non-recursive trees when GitHub truncates the recursive response", async () => {
    const bytes = new TextEncoder().encode("hello");
    const sha = blobSha(bytes);
    const childTreeSha = "5".repeat(40);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      const route = `${url.pathname}${url.search}`;
      if (route === "/repos/o/r/commits/release%2Fnext") {
        return json({ commit: { tree: { sha: ROOT_TREE_SHA } }, sha: COMMIT_SHA });
      }
      if (route === `/repos/o/r/git/trees/${ROOT_TREE_SHA}?recursive=1`) {
        return json({ sha: ROOT_TREE_SHA, tree: [], truncated: true });
      }
      if (route === `/repos/o/r/git/trees/${ROOT_TREE_SHA}`) {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "040000", path: "nested", sha: childTreeSha, type: "tree" }],
          truncated: false,
        });
      }
      if (route === `/repos/o/r/git/trees/${childTreeSha}`) {
        return json({
          sha: childTreeSha,
          tree: [{ mode: "100644", path: "file.txt", sha, size: bytes.byteLength, type: "blob" }],
          truncated: false,
        });
      }
      if (route === `/repos/o/r/git/blobs/${sha}`) return new Response(bytes);
      return new Response("not found", { status: 404 });
    });
    const source = createGithubTemplateSource({
      clientId: "id",
      clientSecret: "secret",
      fetch: fetcher,
    });

    const resolved = await source.resolve({ owner: "o", ref: "release/next", repo: "r" });
    await expect(source.files(resolved)).resolves.toMatchObject([
      { mode: "100644", path: "nested/file.txt" },
    ]);
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.stringContaining("/repos/o/r"),
      expect.objectContaining({ method: expect.anything() }),
    );
  });

  it("rejects submodules and blob-integrity mismatches as explicit source outcomes", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.search === "?recursive=1") {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "160000", path: "vendor", sha: "6".repeat(40), type: "commit" }],
          truncated: false,
        });
      }
      return new Response("wrong bytes");
    });
    const source = createGithubTemplateSource({
      clientId: "id",
      clientSecret: "secret",
      fetch: fetcher,
    });
    const resolved = { commitSha: COMMIT_SHA, owner: "o", repo: "r", treeSha: ROOT_TREE_SHA };

    await expect(source.files(resolved)).rejects.toMatchObject({
      message: 'Template contains unsupported Git submodule "vendor".',
      retryable: false,
    });

    const expectedSha = blobSha(new TextEncoder().encode("expected"));
    fetcher.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.search === "?recursive=1") {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "100644", path: "file", sha: expectedSha, type: "blob" }],
          truncated: false,
        });
      }
      return new Response("wrong bytes");
    });
    await expect(source.files(resolved)).rejects.toSatisfy((error: unknown) =>
      isRetryableGithubTemplateSourceError(error),
    );
  });

  it("enforces the file limit while streaming and keeps interrupted bodies retryable", async () => {
    const oversizedSha = "7".repeat(40);
    let bodyCancelled = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.search === "?recursive=1") {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "100644", path: "large.bin", sha: oversizedSha, type: "blob" }],
          truncated: false,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
          },
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.enqueue(Uint8Array.of(1));
          },
        }),
      );
    });
    const source = createGithubTemplateSource({
      clientId: "id",
      clientSecret: "secret",
      fetch: fetcher,
    });
    const resolved = { commitSha: COMMIT_SHA, owner: "o", repo: "r", treeSha: ROOT_TREE_SHA };

    await expect(source.files(resolved)).rejects.toMatchObject({
      message: expect.stringContaining("per-file limit"),
      retryable: false,
    });
    expect(bodyCancelled).toBe(true);

    fetcher.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.search === "?recursive=1") {
        return json({
          sha: ROOT_TREE_SHA,
          tree: [{ mode: "100644", path: "broken.bin", sha: oversizedSha, type: "blob" }],
          truncated: false,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      );
    });
    await expect(source.files(resolved)).rejects.toSatisfy((error: unknown) =>
      isRetryableGithubTemplateSourceError(error),
    );
  });

  it("classifies missing sources as terminal and service outages as retryable", async () => {
    for (const [status, retryable] of [
      [404, false],
      [503, true],
      [429, true],
    ] as const) {
      const source = createGithubTemplateSource({
        clientId: "id",
        clientSecret: "secret",
        fetch: async () => new Response("no", { status }),
      });
      const error = await source
        .resolve({ owner: "o", ref: "main", repo: "r" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GithubTemplateSourceError);
      expect(error).toMatchObject({ retryable });
    }
  });
});
