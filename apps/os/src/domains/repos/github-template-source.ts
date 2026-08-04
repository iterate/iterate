import git from "isomorphic-git";
import { z } from "zod";
import { isSafeConfigRepoTemplatePath } from "../../lib/config-repo-template-reference.ts";

const MAX_FILE_COUNT = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GITHUB_REF_BYTES = 1024 * 1024;
const MAX_GITHUB_TREE_BYTES = 8 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_TREE_ENTRY_COUNT = 5_000;
const RAW_FETCH_CONCURRENCY = 6;
// The hosted-processor wake lane detects an unresponsive host after ten
// seconds. Every individual public-network request must settle first so a
// transient GitHub delay becomes a classified retry instead of a host revival.
const REQUEST_TIMEOUT_MS = 8_000;

const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Commit = z.object({ sha: GitSha });
const Repository = z.object({ default_branch: z.string().min(1) });
const Branch = z.object({ commit: Commit });
const TreeEntry = z.object({
  hash: GitSha,
  mode: z.string(),
  name: z.string(),
  type: z.enum(["blob", "commit", "symlink", "tree"]),
});
const GithubTree = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      mode: z.string(),
      path: z.string(),
      sha: GitSha,
      size: z.number().int().nonnegative().optional(),
      type: z.enum(["blob", "commit", "tree"]),
    }),
  ),
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

async function listGithubApiTreeFiles(
  source: ResolvedGithubTemplateSource,
  request: typeof globalThis.fetch,
): Promise<ListedFile[]> {
  let response: Response;
  try {
    response = await request(
      `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${source.commitSha}?recursive=1`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "iterate-config-template-importer",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new GithubTemplateSourceError("GitHub could not enumerate the template tree.", {
      cause: error,
      retryable: true,
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubTemplateSourceError(
      `GitHub could not enumerate template commit ${source.commitSha}: HTTP ${response.status}.`,
      { retryable: isRateLimited(response) || response.status >= 500 },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBoundedBytes(response, MAX_GITHUB_TREE_BYTES, "GitHub template tree"),
      ),
    );
  } catch (error) {
    if (error instanceof GithubTemplateSourceError) throw error;
    throw new GithubTemplateSourceError("GitHub returned an invalid template tree response.", {
      cause: error,
      retryable: false,
    });
  }
  const parsed = GithubTree.safeParse(body);
  if (!parsed.success) {
    throw new GithubTemplateSourceError("GitHub returned an unexpected template tree response.", {
      cause: parsed.error,
      retryable: false,
    });
  }
  if (parsed.data.truncated) {
    throw new GithubTemplateSourceError(
      "GitHub truncated this commit's recursive tree; use a branch ref or a smaller template repository.",
      { retryable: false },
    );
  }

  const prefix = source.path === undefined ? "" : `${source.path}/`;
  if (source.path !== undefined) {
    const selected = parsed.data.tree.find((entry) => entry.path === source.path);
    if (selected === undefined) {
      throw new GithubTemplateSourceError(
        `Template path ${JSON.stringify(source.path)} does not exist in ${source.owner}/${source.repo} at ${source.commitSha}.`,
        { retryable: false },
      );
    }
    if (selected.type !== "tree") {
      throw new GithubTemplateSourceError(
        `Template path ${JSON.stringify(source.path)} must be a directory in ${source.owner}/${source.repo}.`,
        { retryable: false },
      );
    }
  }

  const files: ListedFile[] = [];
  const paths = new Set<string>();
  for (const entry of parsed.data.tree) {
    if (!entry.path.startsWith(prefix) || entry.path === source.path) continue;
    const relative = prefix === "" ? entry.path : entry.path.slice(prefix.length);
    assertSafeOutputPath(relative);
    if (entry.type === "tree") continue;
    const file = listedFile({
      blobSha: entry.sha,
      mode: entry.mode,
      path: relative,
      sourcePath: entry.path,
      type: entry.type,
    });
    if (file !== null) {
      if (paths.has(file.path)) {
        throw new GithubTemplateSourceError(
          `GitHub returned duplicate template path ${JSON.stringify(file.path)}.`,
          { retryable: false },
        );
      }
      paths.add(file.path);
      if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
        throw new GithubTemplateSourceError(
          `Template file ${JSON.stringify(relative)} exceeds the ${MAX_FILE_BYTES}-byte per-file limit.`,
          { retryable: false },
        );
      }
      files.push(file);
    }
    if (files.length > MAX_FILE_COUNT) return assertFileLimits(files);
  }
  return assertFileLimits(files);
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
 * subtree. GitHub's public API resolves a ref to an immutable commit and says
 * whether it is an importable branch. Branch trees can then come from a
 * Cloudflare Artifacts server-side shallow import; tags/commits use GitHub's
 * public recursive-tree endpoint. In both cases only selected raw files cross
 * the Worker, and isomorphic-git checks every body against its immutable Git
 * blob hash. */
export function createGithubTemplateSource(
  input: {
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const request = input.fetch ?? globalThis.fetch;

  async function requestGithubJson(
    source: GithubTemplateRequest,
    path: string,
    description: string,
    options: { allowNotFound?: boolean } = {},
  ): Promise<unknown | undefined> {
    let response: Response;
    try {
      response = await request(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}${path}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "iterate-config-template-importer",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new GithubTemplateSourceError(`${description}.`, { cause: error, retryable: true });
    }
    if (response.status === 404 && options.allowNotFound === true) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GithubTemplateSourceError(`${description}: HTTP ${response.status}.`, {
        retryable: isRateLimited(response) || response.status >= 500,
      });
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBoundedBytes(response, MAX_GITHUB_REF_BYTES, "GitHub ref response"),
        ),
      );
    } catch (error) {
      if (error instanceof GithubTemplateSourceError) throw error;
      throw new GithubTemplateSourceError(
        `GitHub returned invalid JSON while ${description.toLowerCase()}.`,
        { cause: error, retryable: false },
      );
    }
  }

  async function resolveCommit(source: GithubTemplateRequest, ref: string): Promise<string> {
    const body = await requestGithubJson(
      source,
      `/commits/${encodeURIComponent(ref)}`,
      `GitHub could not resolve template ref ${JSON.stringify(ref)}`,
    );
    const parsed = Commit.safeParse(body);
    if (!parsed.success) {
      throw new GithubTemplateSourceError(
        `GitHub returned an unexpected response while resolving template ref ${JSON.stringify(ref)}.`,
        { cause: parsed.error, retryable: false },
      );
    }
    return parsed.data.sha;
  }

  return {
    async resolve(source: GithubTemplateRequest): Promise<ResolvedGithubTemplateSource> {
      if (source.path !== undefined && !isSafeConfigRepoTemplatePath(source.path)) {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} must stay within the public repository and outside .git.`,
          { retryable: false },
        );
      }
      if (source.ref !== undefined && GitSha.safeParse(source.ref).success) {
        return { ...source, commitSha: source.ref };
      }

      if (source.ref === undefined) {
        const repository = Repository.safeParse(
          await requestGithubJson(
            source,
            "",
            `GitHub could not read public repository ${source.owner}/${source.repo}`,
          ),
        );
        if (!repository.success) {
          throw new GithubTemplateSourceError(
            `GitHub returned an unexpected response for public repository ${source.owner}/${source.repo}.`,
            { cause: repository.error, retryable: false },
          );
        }
        const branch = repository.data.default_branch;
        return { ...source, branch, commitSha: await resolveCommit(source, branch) };
      }

      const branchBody = await requestGithubJson(
        source,
        `/branches/${encodeURIComponent(source.ref)}`,
        `GitHub could not resolve template branch ${JSON.stringify(source.ref)}`,
        { allowNotFound: true },
      );
      if (branchBody !== undefined) {
        const branch = Branch.safeParse(branchBody);
        if (!branch.success) {
          throw new GithubTemplateSourceError(
            `GitHub returned an unexpected response while resolving template branch ${JSON.stringify(source.ref)}.`,
            { cause: branch.error, retryable: false },
          );
        }
        return { ...source, branch: source.ref, commitSha: branch.data.commit.sha };
      }
      return { ...source, commitSha: await resolveCommit(source, source.ref) };
    },

    async files(
      source: ResolvedGithubTemplateSource,
      treeReader?: GithubTemplateTreeReader,
    ): Promise<GithubTemplateFile[]> {
      const listed =
        treeReader === undefined
          ? await listGithubApiTreeFiles(source, request)
          : await listArtifactTreeFiles(source, treeReader);
      return await downloadFiles(source, listed, request);
    },
  };
}
