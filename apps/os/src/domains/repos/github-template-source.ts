import git from "isomorphic-git";
import type { HttpClient } from "isomorphic-git/http/web";
import { z } from "zod";
import { isSafeConfigRepoTemplatePath } from "../../lib/config-repo-template-reference.ts";

const MAX_FILE_COUNT = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GITHUB_REF_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_TREE_ENTRY_COUNT = 5_000;
const RAW_FETCH_CONCURRENCY = 6;
// The hosted-processor wake lane detects an unresponsive host after ten
// seconds. Every individual public-network request must settle first so a
// transient GitHub delay becomes a classified retry instead of a host revival.
const REQUEST_TIMEOUT_MS = 8_000;

const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
const TreeEntry = z.object({
  hash: GitSha,
  mode: z.string(),
  name: z.string(),
  type: z.enum(["blob", "commit", "symlink", "tree"]),
});

export type GithubTemplateRequest = {
  owner: string;
  path?: string;
  ref?: string;
  repo: string;
};

export type ResolvedGithubTemplateSource = GithubTemplateRequest & {
  /** Present when Cloudflare Artifacts can import the source directly. */
  branch?: string;
  commitSha: string;
};

export type GithubTemplateFile = {
  bytes: Uint8Array;
  mode: "100644" | "120000";
  path: string;
};

function resolvedGithubTemplateSource(
  source: GithubTemplateRequest,
  commitSha: string,
  branch?: string,
): ResolvedGithubTemplateSource {
  return {
    ...(branch === undefined ? {} : { branch }),
    commitSha,
    owner: source.owner,
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    repo: source.repo,
  };
}

type GithubTemplateTreeReader = {
  readTree(hash: string): Promise<unknown>;
  rootTreeHash: string;
};

type ListedFile = {
  blobSha: string;
  mode: GithubTemplateFile["mode"];
  path: string;
  sourcePath: string;
};

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

async function readBoundedBytes(
  response: Response,
  limit: number,
  description: string,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubTemplateSourceError(`${description} exceeds the ${limit}-byte limit.`, {
      retryable: false,
    });
  }

  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new GithubTemplateSourceError(`${description} exceeds the ${limit}-byte limit.`, {
          retryable: false,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GithubTemplateSourceError) throw error;
    throw new GithubTemplateSourceError(`${description} response body could not be read.`, {
      cause: error,
      retryable: true,
    });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertSafeTreeName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new GithubTemplateSourceError(
      `Template tree contains unsafe entry name ${JSON.stringify(name)}.`,
      { retryable: false },
    );
  }
}

function listedFile(input: {
  blobSha: string;
  mode: string;
  path: string;
  sourcePath: string;
  type: "blob" | "commit" | "symlink" | "tree";
}): ListedFile | null {
  if (input.type === "tree") return null;
  if (input.type === "commit" || !["100644", "100755", "120000"].includes(input.mode)) {
    throw new GithubTemplateSourceError(
      `Template contains unsupported Git entry ${JSON.stringify(input.path)} (mode ${input.mode}, type ${input.type}).`,
      { retryable: false },
    );
  }
  assertSafeOutputPath(input.path);
  return {
    blobSha: input.blobSha,
    mode: input.mode === "120000" ? "120000" : "100644",
    path: input.path,
    sourcePath: input.sourcePath,
  };
}

function assertSafeOutputPath(path: string): void {
  if (
    !isSafeConfigRepoTemplatePath(path) ||
    new TextEncoder().encode(path).length > MAX_PATH_BYTES
  ) {
    throw new GithubTemplateSourceError(
      `Template contains unsafe or overlong path ${JSON.stringify(path)}.`,
      { retryable: false },
    );
  }
}

function assertFileLimits(files: ListedFile[]): ListedFile[] {
  if (files.length === 0) {
    throw new GithubTemplateSourceError("The selected template directory contains no files.", {
      retryable: false,
    });
  }
  if (files.length > MAX_FILE_COUNT) {
    throw new GithubTemplateSourceError(
      `Template contains more than the ${MAX_FILE_COUNT}-file limit.`,
      { retryable: false },
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function listArtifactTreeFiles(
  source: ResolvedGithubTemplateSource,
  reader: GithubTemplateTreeReader,
): Promise<ListedFile[]> {
  const readTree = async (hash: string) => {
    const parsed = z.array(TreeEntry).safeParse(await reader.readTree(hash));
    if (!parsed.success) {
      throw new GithubTemplateSourceError("Cloudflare Artifacts returned an invalid Git tree.", {
        cause: parsed.error,
        retryable: true,
      });
    }
    for (const entry of parsed.data) assertSafeTreeName(entry.name);
    return parsed.data;
  };

  let selectedTreeHash = reader.rootTreeHash;
  if (source.path !== undefined) {
    for (const segment of source.path.split("/")) {
      const entry = (await readTree(selectedTreeHash)).find(
        (candidate) => candidate.name === segment,
      );
      if (entry === undefined) {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} does not exist in ${source.owner}/${source.repo} at ${source.commitSha}.`,
          { retryable: false },
        );
      }
      if (entry.type !== "tree") {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} must be a directory in ${source.owner}/${source.repo}.`,
          { retryable: false },
        );
      }
      selectedTreeHash = entry.hash;
    }
  }

  const files: ListedFile[] = [];
  const pending = [{ hash: selectedTreeHash, relative: "" }];
  let treeEntryCount = 0;
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) break;
    for (const entry of await readTree(directory.hash)) {
      treeEntryCount += 1;
      if (treeEntryCount > MAX_TREE_ENTRY_COUNT) {
        throw new GithubTemplateSourceError(
          `Template contains more than the ${MAX_TREE_ENTRY_COUNT}-entry tree limit.`,
          { retryable: false },
        );
      }
      const relative =
        directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
      const sourcePath = source.path === undefined ? relative : `${source.path}/${relative}`;
      assertSafeOutputPath(relative);
      if (entry.type === "tree") {
        pending.push({ hash: entry.hash, relative });
        continue;
      }
      const file = listedFile({
        blobSha: entry.hash,
        mode: entry.mode,
        path: relative,
        sourcePath,
        type: entry.type,
      });
      if (file !== null) files.push(file);
      if (files.length > MAX_FILE_COUNT) return assertFileLimits(files);
    }
  }
  return assertFileLimits(files);
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  );
}

function asyncBytes(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

function githubSmartHttp(
  request: typeof globalThis.fetch,
  source: GithubTemplateRequest,
): HttpClient {
  return {
    request: async ({ headers, method, url }) => {
      let response: Response;
      try {
        response = await request(url, {
          headers,
          method,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GithubTemplateSourceError(
          `GitHub could not advertise refs for ${source.owner}/${source.repo}.`,
          { cause: error, retryable: true },
        );
      }

      const responseHeaders = Object.fromEntries(response.headers.entries());
      const bytes = await readBoundedBytes(
        response,
        MAX_GITHUB_REF_BYTES,
        "GitHub Git ref advertisement",
      );
      return {
        body: asyncBytes(bytes),
        headers: responseHeaders,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        url: response.url,
      };
    },
  };
}

async function listGithubServerRefs(
  source: GithubTemplateRequest,
  request: typeof globalThis.fetch,
) {
  try {
    // Protocol v1 advertises HEAD, its symref, branches, tags, and peeled tags
    // in one bounded response. Unlike GitHub's unauthenticated REST API this
    // is the public Git transport itself, so shared Cloudflare egress does not
    // consume a tiny accountless API quota just to resolve a public ref.
    return await git.listServerRefs({
      http: githubSmartHttp(request, source),
      peelTags: true,
      protocolVersion: 1,
      symrefs: true,
      url: `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}.git`,
    });
  } catch (error) {
    if (error instanceof GithubTemplateSourceError) throw error;
    const status =
      (error as { data?: { statusCode?: unknown } } | null)?.data?.statusCode ?? undefined;
    throw new GithubTemplateSourceError(
      `GitHub could not advertise refs for ${source.owner}/${source.repo}${
        typeof status === "number" ? `: HTTP ${status}` : ""
      }.`,
      {
        cause: error,
        retryable: status === 429 || (typeof status === "number" && status >= 500),
      },
    );
  }
}

async function downloadFiles(
  source: ResolvedGithubTemplateSource,
  listed: ListedFile[],
  request: typeof globalThis.fetch,
): Promise<GithubTemplateFile[]> {
  const results = new Array<GithubTemplateFile>(listed.length);
  const abort = new AbortController();
  let nextIndex = 0;
  let totalBytes = 0;

  const download = async () => {
    while (!abort.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const file = listed[index];
      if (file === undefined) return;
      let response: Response;
      try {
        response = await request(
          `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${source.commitSha}/${file.sourcePath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) },
        );
      } catch (error) {
        if (abort.signal.aborted) throw error;
        throw new GithubTemplateSourceError(
          `GitHub could not read template file ${JSON.stringify(file.sourcePath)}.`,
          { cause: error, retryable: true },
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GithubTemplateSourceError(
          `GitHub could not read template file ${JSON.stringify(file.sourcePath)}: HTTP ${response.status}.`,
          { retryable: isRateLimited(response) || response.status >= 500 },
        );
      }
      const bytes = await readBoundedBytes(
        response,
        MAX_FILE_BYTES,
        `Template file ${JSON.stringify(file.path)}`,
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new GithubTemplateSourceError(
          `Template exceeds the ${MAX_TOTAL_BYTES}-byte total size limit.`,
          { retryable: false },
        );
      }
      const { oid } = await git.hashBlob({ object: bytes });
      if (oid !== file.blobSha) {
        throw new GithubTemplateSourceError(
          `GitHub returned bytes for ${JSON.stringify(file.sourcePath)} with blob ${oid}; expected ${file.blobSha}.`,
          { retryable: true },
        );
      }
      results[index] = { bytes, mode: file.mode, path: file.path };
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(RAW_FETCH_CONCURRENCY, listed.length) }, download),
    );
  } catch (error) {
    abort.abort();
    throw error;
  }
  return results;
}

/** A bounded, read-only GitHub adapter for copying a public repository
 * subtree. Git smart HTTP resolves a ref to an immutable commit and says
 * whether it is an importable branch. Cloudflare Artifacts imports Git
 * objects server-side and supplies the selected immutable tree; only selected
 * raw file bodies cross the Worker, and isomorphic-git checks every body
 * against its advertised Git blob hash. */
export function createGithubTemplateSource(
  input: {
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const request = input.fetch ?? globalThis.fetch;

  return {
    async resolve(source: GithubTemplateRequest): Promise<ResolvedGithubTemplateSource> {
      if (source.path !== undefined && !isSafeConfigRepoTemplatePath(source.path)) {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} must stay within the public repository and outside .git.`,
          { retryable: false },
        );
      }
      if (source.ref !== undefined && GitSha.safeParse(source.ref).success) {
        return resolvedGithubTemplateSource(source, source.ref);
      }

      const refs = await listGithubServerRefs(source, request);
      if (source.ref === undefined) {
        const head = refs.find((candidate) => candidate.ref === "HEAD");
        if (head?.target === undefined || !head.target.startsWith("refs/heads/")) {
          throw new GithubTemplateSourceError(
            `Public repository ${source.owner}/${source.repo} does not advertise a default branch.`,
            { retryable: false },
          );
        }
        const branch = head.target.slice("refs/heads/".length);
        return resolvedGithubTemplateSource(source, head.oid, branch);
      }

      const branch = refs.find((candidate) => candidate.ref === `refs/heads/${source.ref}`);
      if (branch !== undefined) {
        return resolvedGithubTemplateSource(source, branch.oid, source.ref);
      }
      const tag = refs.find((candidate) => candidate.ref === `refs/tags/${source.ref}`);
      if (tag !== undefined) {
        return resolvedGithubTemplateSource(source, tag.peeled ?? tag.oid);
      }

      throw new GithubTemplateSourceError(
        `GitHub does not advertise template ref ${JSON.stringify(source.ref)} in ${source.owner}/${source.repo}; use a branch, tag, or full 40-character commit SHA.`,
        { retryable: false },
      );
    },

    async files(
      source: ResolvedGithubTemplateSource,
      treeReader: GithubTemplateTreeReader,
    ): Promise<GithubTemplateFile[]> {
      const listed = await listArtifactTreeFiles(source, treeReader);
      return await downloadFiles(source, listed, request);
    },
  };
}
