import { z } from "zod";

const MAX_FILE_COUNT = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TREE_REQUESTS = 4_000;
const BLOB_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;

const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Repository = z.object({ default_branch: z.string().trim().min(1) });
const Commit = z.object({
  commit: z.object({ tree: z.object({ sha: GitSha }) }),
  sha: GitSha,
});
const TreeEntry = z.object({
  mode: z.string(),
  path: z.string().min(1),
  sha: GitSha,
  size: z.number().int().nonnegative().optional(),
  type: z.enum(["blob", "tree", "commit"]),
});
const Tree = z.object({
  sha: GitSha,
  tree: z.array(TreeEntry),
  truncated: z.boolean(),
});

export type GithubTemplateRequest = {
  owner: string;
  path?: string;
  ref?: string;
  repo: string;
};

export type ResolvedGithubTemplateSource = GithubTemplateRequest & {
  commitSha: string;
  treeSha: string;
};

export type GithubTemplateFile = {
  bytes: Uint8Array;
  mode: "100644" | "100755" | "120000";
  path: string;
};

type GithubTreeEntry = z.output<typeof TreeEntry>;

/** A source failure whose classification controls whether the repo creation
 * obligation remains open for recovery or terminates as create-failed. */
export class GithubTemplateSourceError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { cause?: unknown; retryable: boolean }) {
    super(message, { cause: options.cause });
    this.name = "GithubTemplateSourceError";
    this.retryable = options.retryable;
  }
}

export function isRetryableGithubTemplateSourceError(
  error: unknown,
): error is GithubTemplateSourceError {
  return error instanceof GithubTemplateSourceError && error.retryable;
}

/** A bounded, read-only GitHub adapter for copying a public repository
 * subtree. It resolves moving refs separately from fetching blobs so callers
 * can durably journal the immutable commit before materialization begins. */
export function createGithubTemplateSource(input: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
}) {
  const request = input.fetch ?? globalThis.fetch;
  const authorization = `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`;

  async function api(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    let response: Response;
    try {
      response = await request(`https://api.github.com${path}`, {
        headers: {
          accept,
          authorization,
          "user-agent": "iterate-config-template-importer",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GithubTemplateSourceError(
        "GitHub could not be reached while copying the template.",
        {
          cause: error,
          retryable: true,
        },
      );
    }
    if (response.ok) return response;

    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          response.headers.get("x-ratelimit-remaining") === "0"));
    const retryable = rateLimited || response.status >= 500;
    throw new GithubTemplateSourceError(
      `GitHub rejected template source request ${path}: HTTP ${response.status}.`,
      { retryable },
    );
  }

  async function json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await api(path);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new GithubTemplateSourceError(`GitHub returned invalid JSON for ${path}.`, {
        cause: error,
        retryable: true,
      });
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new GithubTemplateSourceError(`GitHub returned an unexpected response for ${path}.`, {
        cause: result.error,
        retryable: true,
      });
    }
    return result.data;
  }

  function repoPath(source: GithubTemplateRequest): string {
    return `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  }

  async function tree(source: GithubTemplateRequest, sha: string, recursive = false) {
    return await json(
      `${repoPath(source)}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`,
      Tree,
    );
  }

  async function selectedTreeSha(source: ResolvedGithubTemplateSource): Promise<string> {
    if (source.path === undefined) return source.treeSha;

    let currentTreeSha = source.treeSha;
    for (const segment of source.path.split("/")) {
      const currentTree = await tree(source, currentTreeSha);
      const entry = currentTree.tree.find((candidate) => candidate.path === segment);
      if (entry === undefined) {
        throw new GithubTemplateSourceError(
          `Template path "${source.path}" does not exist in ${source.owner}/${source.repo} at ${source.commitSha}.`,
          { retryable: false },
        );
      }
      if (entry.type !== "tree") {
        throw new GithubTemplateSourceError(
          `Template path "${source.path}" must be a directory in ${source.owner}/${source.repo}.`,
          { retryable: false },
        );
      }
      currentTreeSha = entry.sha;
    }
    return currentTreeSha;
  }

  function validateFileEntry(entry: GithubTreeEntry, path: string): void {
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new GithubTemplateSourceError(
        `Template contains unsupported Git submodule "${path}".`,
        { retryable: false },
      );
    }
    if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode)) {
      throw new GithubTemplateSourceError(
        `Template contains unsupported Git entry "${path}" (${entry.type} ${entry.mode}).`,
        { retryable: false },
      );
    }
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\0") ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new GithubTemplateSourceError(`Template contains unsafe path "${path}".`, {
        retryable: false,
      });
    }
    if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
      throw new GithubTemplateSourceError(
        `Template file "${path}" exceeds the ${MAX_FILE_BYTES}-byte per-file limit.`,
        { retryable: false },
      );
    }
  }

  function assertEntryLimits(entries: Array<GithubTreeEntry & { outputPath: string }>): void {
    if (entries.length === 0) {
      throw new GithubTemplateSourceError("The selected template directory contains no files.", {
        retryable: false,
      });
    }
    if (entries.length > MAX_FILE_COUNT) {
      throw new GithubTemplateSourceError(
        `Template contains ${entries.length} files; the limit is ${MAX_FILE_COUNT}.`,
        { retryable: false },
      );
    }
    const knownBytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
    if (knownBytes > MAX_TOTAL_BYTES) {
      throw new GithubTemplateSourceError(
        `Template exceeds the ${MAX_TOTAL_BYTES}-byte total size limit.`,
        { retryable: false },
      );
    }
  }

  async function listFiles(
    source: ResolvedGithubTemplateSource,
  ): Promise<Array<GithubTreeEntry & { outputPath: string }>> {
    const rootSha = await selectedTreeSha(source);
    const recursive = await tree(source, rootSha, true);
    if (!recursive.truncated) {
      const entries = recursive.tree.flatMap((entry) => {
        if (entry.type === "tree") return [];
        validateFileEntry(entry, entry.path);
        return [{ ...entry, outputPath: entry.path }];
      });
      assertEntryLimits(entries);
      return entries;
    }

    const files: Array<GithubTreeEntry & { outputPath: string }> = [];
    const pending = [{ prefix: "", sha: rootSha }];
    let requestedTrees = 0;
    while (pending.length > 0) {
      const directory = pending.shift();
      if (directory === undefined) break;
      requestedTrees += 1;
      if (requestedTrees > MAX_TREE_REQUESTS) {
        throw new GithubTemplateSourceError(
          `Template exceeds the ${MAX_TREE_REQUESTS}-directory traversal limit.`,
          { retryable: false },
        );
      }
      const listing = await tree(source, directory.sha);
      for (const entry of listing.tree) {
        const outputPath =
          directory.prefix.length === 0 ? entry.path : `${directory.prefix}/${entry.path}`;
        if (entry.type === "tree") {
          pending.push({ prefix: outputPath, sha: entry.sha });
          continue;
        }
        validateFileEntry(entry, outputPath);
        files.push({ ...entry, outputPath });
        if (files.length > MAX_FILE_COUNT) {
          throw new GithubTemplateSourceError(
            `Template contains more than the ${MAX_FILE_COUNT}-file limit.`,
            { retryable: false },
          );
        }
      }
    }
    assertEntryLimits(files);
    return files;
  }

  async function blob(source: ResolvedGithubTemplateSource, entry: GithubTreeEntry) {
    const response = await api(
      `${repoPath(source)}/git/blobs/${entry.sha}`,
      "application/vnd.github.raw+json",
    );
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_FILE_BYTES) {
      throw new GithubTemplateSourceError(
        `Template file "${entry.path}" exceeds the ${MAX_FILE_BYTES}-byte per-file limit.`,
        { retryable: false },
      );
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new GithubTemplateSourceError(`GitHub returned no body for "${entry.path}".`, {
        retryable: true,
      });
    }
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        byteLength += chunk.value.byteLength;
        if (byteLength > MAX_FILE_BYTES) {
          await reader.cancel();
          throw new GithubTemplateSourceError(
            `Template file "${entry.path}" exceeds the ${MAX_FILE_BYTES}-byte per-file limit.`,
            { retryable: false },
          );
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof GithubTemplateSourceError) throw error;
      throw new GithubTemplateSourceError(
        `GitHub blob body could not be read for "${entry.path}".`,
        { cause: error, retryable: true },
      );
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const canonical = new Uint8Array(header.byteLength + bytes.byteLength);
    canonical.set(header);
    canonical.set(bytes, header.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", canonical));
    const sha = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha !== entry.sha) {
      throw new GithubTemplateSourceError(
        `GitHub blob integrity check failed for "${entry.path}" (expected ${entry.sha}, received ${sha}).`,
        { retryable: true },
      );
    }
    return bytes;
  }

  return {
    async resolve(source: GithubTemplateRequest): Promise<ResolvedGithubTemplateSource> {
      const ref = source.ref ?? (await json(repoPath(source), Repository)).default_branch;
      const commit = await json(`${repoPath(source)}/commits/${encodeURIComponent(ref)}`, Commit);
      return {
        ...source,
        commitSha: commit.sha,
        treeSha: commit.commit.tree.sha,
      };
    },

    async files(source: ResolvedGithubTemplateSource): Promise<GithubTemplateFile[]> {
      const entries = await listFiles(source);
      const results = new Array<GithubTemplateFile>(entries.length);
      let totalBytes = 0;
      let cursor = 0;

      await Promise.all(
        Array.from({ length: Math.min(BLOB_CONCURRENCY, entries.length) }, async () => {
          while (cursor < entries.length) {
            const index = cursor;
            cursor += 1;
            const entry = entries[index];
            if (entry === undefined) break;
            const bytes = await blob(source, entry);
            totalBytes += bytes.byteLength;
            if (totalBytes > MAX_TOTAL_BYTES) {
              throw new GithubTemplateSourceError(
                `Template exceeds the ${MAX_TOTAL_BYTES}-byte total size limit.`,
                { retryable: false },
              );
            }
            results[index] = {
              bytes,
              mode:
                entry.mode === "120000" ? "120000" : entry.mode === "100755" ? "100755" : "100644",
              path: entry.outputPath,
            };
          }
        }),
      );
      return results.sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}
