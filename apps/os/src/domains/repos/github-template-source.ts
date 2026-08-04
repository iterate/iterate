import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import git, { type ServerRef } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";
import { isSafeConfigRepoTemplatePath } from "../../lib/config-repo-template-reference.ts";

const MAX_FILE_COUNT = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SOURCE_DIR = "/template-source";

const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
const Commit = z.object({ sha: GitSha });
const GitFailure = z
  .object({
    code: z.string().optional(),
    data: z.object({ statusCode: z.number().int().optional() }).loose().optional(),
  })
  .loose();

export type GithubTemplateRequest = {
  owner: string;
  path?: string;
  ref?: string;
  repo: string;
};

export type ResolvedGithubTemplateSource = GithubTemplateRequest & {
  commitSha: string;
};

export type GithubTemplateFile = {
  bytes: Uint8Array;
  mode: "100644" | "120000";
  path: string;
};

type TemplateCheckout = {
  filesystem: Pick<
    InMemoryFs,
    "exists" | "lstat" | "readdirWithFileTypes" | "readFileBytes" | "readlink"
  >;
  headSha: string;
  root: string;
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

function githubRemote(source: GithubTemplateRequest): string {
  return `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}.git`;
}

function classifyGitFailure(message: string, error: unknown): GithubTemplateSourceError {
  if (error instanceof GithubTemplateSourceError) return error;
  const parsed = GitFailure.safeParse(error);
  const status = parsed.success ? parsed.data.data?.statusCode : undefined;
  const code = parsed.success ? parsed.data.code : undefined;
  return new GithubTemplateSourceError(message, {
    cause: error,
    retryable:
      status === 429 ||
      (status !== undefined && status >= 500) ||
      (status === undefined && code !== "NotFoundError"),
  });
}

/** A bounded, read-only GitHub adapter for copying a public repository
 * subtree. Isomorphic Git resolves and shallow-clones the public smart-HTTP
 * remote directly: no archive extraction or credential is involved. Moving
 * refs are resolved and journaled as immutable commit SHAs before a separate
 * clone materializes their files. Only an unadvertised abbreviated commit
 * needs one unauthenticated GitHub API lookup. */
export function createGithubTemplateSource(
  input: {
    checkout?: (source: ResolvedGithubTemplateSource) => Promise<TemplateCheckout>;
    fetch?: typeof globalThis.fetch;
    readServerRefs?: (url: string) => Promise<ServerRef[]>;
  } = {},
) {
  const request = input.fetch ?? globalThis.fetch;
  const readServerRefs =
    input.readServerRefs ??
    ((url: string) => git.listServerRefs({ http, peelTags: true, symrefs: true, url }));
  const checkout =
    input.checkout ??
    (async (source: ResolvedGithubTemplateSource): Promise<TemplateCheckout> => {
      const filesystem = new InMemoryFs();
      const sourceGit = createGit(filesystem, SOURCE_DIR);
      try {
        await sourceGit.clone({
          branch: source.commitSha,
          depth: 1,
          singleBranch: true,
          url: githubRemote(source),
        });
      } catch (error) {
        throw classifyGitFailure(
          `Could not shallow-clone public GitHub template ${source.owner}/${source.repo} at ${source.commitSha}.`,
          error,
        );
      }
      const [head] = await sourceGit.log({ depth: 1 });
      if (head?.oid !== source.commitSha) {
        throw new GithubTemplateSourceError(
          `GitHub template clone resolved ${head?.oid ?? "no head"}; expected ${source.commitSha}.`,
          { retryable: true },
        );
      }
      return { filesystem, headSha: head.oid, root: SOURCE_DIR };
    });

  async function resolveUnadvertisedRef(source: GithubTemplateRequest, ref: string) {
    let response: Response;
    try {
      response = await request(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(ref)}`,
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
      throw new GithubTemplateSourceError(
        `GitHub could not resolve template ref ${JSON.stringify(ref)}.`,
        { cause: error, retryable: true },
      );
    }
    if (!response.ok) {
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"));
      throw new GithubTemplateSourceError(
        `GitHub could not resolve template ref ${JSON.stringify(ref)}: HTTP ${response.status}.`,
        { retryable: rateLimited || response.status >= 500 },
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new GithubTemplateSourceError(
        `GitHub returned invalid JSON while resolving template ref ${JSON.stringify(ref)}.`,
        { cause: error, retryable: true },
      );
    }
    const parsed = Commit.safeParse(body);
    if (!parsed.success) {
      throw new GithubTemplateSourceError(
        `GitHub returned an unexpected response while resolving template ref ${JSON.stringify(ref)}.`,
        { cause: parsed.error, retryable: true },
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
      let refs: ServerRef[];
      try {
        refs = await readServerRefs(githubRemote(source));
      } catch (error) {
        throw classifyGitFailure(
          `Could not read public Git refs for ${source.owner}/${source.repo}.`,
          error,
        );
      }

      let commitSha: string | undefined;
      if (source.ref === undefined) {
        commitSha = refs.find((candidate) => candidate.ref === "HEAD")?.oid;
      } else {
        const branch = refs.find((candidate) => candidate.ref === `refs/heads/${source.ref}`);
        const tag = refs.find((candidate) => candidate.ref === `refs/tags/${source.ref}`);
        commitSha = branch?.oid ?? tag?.peeled ?? tag?.oid;
        if (commitSha === undefined && GitSha.safeParse(source.ref).success) {
          commitSha = source.ref;
        }
        if (commitSha === undefined) commitSha = await resolveUnadvertisedRef(source, source.ref);
      }
      if (commitSha === undefined) {
        throw new GithubTemplateSourceError(
          `Public GitHub template ${source.owner}/${source.repo} has no default branch.`,
          { retryable: false },
        );
      }
      return { ...source, commitSha };
    },

    async files(source: ResolvedGithubTemplateSource): Promise<GithubTemplateFile[]> {
      const materialized = await checkout(source);
      if (materialized.headSha !== source.commitSha) {
        throw new GithubTemplateSourceError(
          `GitHub template checkout resolved ${materialized.headSha}; expected ${source.commitSha}.`,
          { retryable: true },
        );
      }
      const selectedRoot =
        source.path === undefined
          ? materialized.root
          : `${materialized.root}/${source.path.split("/").join("/")}`;
      if (!(await materialized.filesystem.exists(selectedRoot))) {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} does not exist in ${source.owner}/${source.repo} at ${source.commitSha}.`,
          { retryable: false },
        );
      }
      if ((await materialized.filesystem.lstat(selectedRoot)).type !== "directory") {
        throw new GithubTemplateSourceError(
          `Template path ${JSON.stringify(source.path)} must be a directory in ${source.owner}/${source.repo}.`,
          { retryable: false },
        );
      }

      const files: GithubTemplateFile[] = [];
      const pending = [{ absolute: selectedRoot, relative: "" }];
      let totalBytes = 0;
      while (pending.length > 0) {
        const directory = pending.shift();
        if (directory === undefined) break;
        const entries = (
          await materialized.filesystem.readdirWithFileTypes(directory.absolute)
        ).sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (directory.relative === "" && source.path === undefined && entry.name === ".git") {
            continue;
          }
          const absolute = `${directory.absolute}/${entry.name}`;
          const relative =
            directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
          if (entry.type === "directory") {
            pending.push({ absolute, relative });
            continue;
          }
          if (entry.type !== "file" && entry.type !== "symlink") {
            throw new GithubTemplateSourceError(
              `Template contains unsupported filesystem entry ${JSON.stringify(relative)}.`,
              { retryable: false },
            );
          }
          const bytes =
            entry.type === "symlink"
              ? new TextEncoder().encode(await materialized.filesystem.readlink(absolute))
              : await materialized.filesystem.readFileBytes(absolute);
          if (bytes.byteLength > MAX_FILE_BYTES) {
            throw new GithubTemplateSourceError(
              `Template file ${JSON.stringify(relative)} exceeds the ${MAX_FILE_BYTES}-byte per-file limit.`,
              { retryable: false },
            );
          }
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_TOTAL_BYTES) {
            throw new GithubTemplateSourceError(
              `Template exceeds the ${MAX_TOTAL_BYTES}-byte total size limit.`,
              { retryable: false },
            );
          }
          files.push({
            bytes,
            mode: entry.type === "symlink" ? "120000" : "100644",
            path: relative,
          });
          if (files.length > MAX_FILE_COUNT) {
            throw new GithubTemplateSourceError(
              `Template contains more than the ${MAX_FILE_COUNT}-file limit.`,
              { retryable: false },
            );
          }
        }
      }
      if (files.length === 0) {
        throw new GithubTemplateSourceError("The selected template directory contains no files.", {
          retryable: false,
        });
      }
      return files.sort((left, right) => left.path.localeCompare(right.path));
    },
  };
}
