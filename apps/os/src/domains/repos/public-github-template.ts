import { z } from "zod";
import {
  isSafeConfigRepoTemplatePath,
  type ConfigRepoTemplateReference,
} from "../../lib/config-repo-template-reference.ts";
import { RetryableRepoCreationError } from "./utils.ts";

const DOWNLOAD_CONCURRENCY = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const MAX_GITHUB_API_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const CommitResponse = z.object({
  commit: z.object({ tree: z.object({ sha: z.string().regex(SHA_PATTERN) }) }),
  sha: z.string().regex(SHA_PATTERN),
});

const TreeResponse = z.object({
  tree: z.array(
    z.object({
      mode: z.string(),
      path: z.string(),
      size: z.number().int().nonnegative().optional(),
      type: z.enum(["blob", "commit", "tree"]),
    }),
  ),
  truncated: z.boolean(),
});

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Copy a public GitHub repository folder into the same text-file structure as
 * the generated default config template. GitHub is used only to enumerate and
 * read a coherent snapshot; no repository or source history is cloned.
 */
export async function downloadPublicGithubTemplate(
  reference: ConfigRepoTemplateReference,
  githubFetch: GithubFetch = globalThis.fetch,
): Promise<Array<{ content: string; path: string }>> {
  const repository = `${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
  const requestedRef = encodeURIComponent(reference.ref ?? "HEAD");
  const commit = await fetchGithubJson(
    githubFetch,
    `https://api.github.com/repos/${repository}/commits/${requestedRef}`,
    CommitResponse,
  );
  const tree = await fetchGithubJson(
    githubFetch,
    `https://api.github.com/repos/${repository}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    TreeResponse,
  );

  if (tree.truncated) {
    throw new Error("The GitHub repository tree is too large to copy as a config template.");
  }

  const prefix = !reference.path ? "" : `${reference.path}/`;
  if (
    reference.path &&
    !tree.tree.some((entry) => entry.type === "tree" && entry.path === reference.path)
  ) {
    throw new Error(`Config template folder ${JSON.stringify(reference.path)} was not found.`);
  }

  const selectedEntries = tree.tree.filter(
    (entry) => prefix === "" || entry.path.startsWith(prefix),
  );
  const unsupportedEntry = selectedEntries.find(
    (entry) =>
      entry.type === "commit" ||
      (entry.type === "blob" && entry.mode !== "100644" && entry.mode !== "100755"),
  );
  if (unsupportedEntry) {
    throw new Error(
      `Config templates cannot contain submodules or symbolic links (${unsupportedEntry.path}).`,
    );
  }

  const files: Array<{ path: string; size: number | undefined; sourcePath: string }> = [];
  for (const entry of selectedEntries) {
    if (entry.type !== "blob") continue;
    files.push({
      path: prefix === "" ? entry.path : entry.path.slice(prefix.length),
      size: entry.size,
      sourcePath: entry.path,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  if (files.length === 0) {
    throw new Error("The selected config template contains no files.");
  }
  if (files.length > MAX_FILE_COUNT) {
    throw new Error(`The selected config template contains more than ${MAX_FILE_COUNT} files.`);
  }

  let reportedTotalBytes = 0;
  for (const file of files) {
    if (!isSafeConfigRepoTemplatePath(file.path)) {
      throw new Error(
        `The selected config template contains an unsafe path: ${JSON.stringify(file.path)}.`,
      );
    }
    if (!Number.isFinite(file.size)) {
      throw new Error(
        `GitHub did not report the size of template file ${JSON.stringify(file.sourcePath)}.`,
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(
        `Template file ${JSON.stringify(file.sourcePath)} exceeds ${MAX_FILE_BYTES} bytes.`,
      );
    }
    reportedTotalBytes += file.size;
  }
  if (reportedTotalBytes > MAX_TEMPLATE_BYTES) {
    throw new Error(`The selected config template exceeds ${MAX_TEMPLATE_BYTES} bytes.`);
  }

  const downloaded: Array<{ content: string; path: string }> = [];
  let downloadedBytes = 0;
  for (let index = 0; index < files.length; index += DOWNLOAD_CONCURRENCY) {
    downloaded.push(
      ...(await Promise.all(
        files.slice(index, index + DOWNLOAD_CONCURRENCY).map(async (file) => {
          const rawPath = file.sourcePath.split("/").map(encodeURIComponent).join("/");
          const bytes = await fetchGithub(
            githubFetch,
            `https://raw.githubusercontent.com/${repository}/${commit.sha}/${rawPath}`,
            MAX_FILE_BYTES,
          );
          downloadedBytes += bytes.byteLength;
          if (downloadedBytes > MAX_TEMPLATE_BYTES) {
            throw new Error(`The selected config template exceeds ${MAX_TEMPLATE_BYTES} bytes.`);
          }
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (error) {
            throw new Error(
              `Config template file ${JSON.stringify(file.sourcePath)} is not UTF-8 text.`,
              { cause: error },
            );
          }
          return { content, path: file.path };
        }),
      )),
    );
  }
  return downloaded;
}

async function fetchGithubJson<T>(
  githubFetch: GithubFetch,
  url: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const responseBytes = await fetchGithub(githubFetch, url, MAX_GITHUB_API_RESPONSE_BYTES);
  const responseText = new TextDecoder().decode(responseBytes);
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch (error) {
    throw new Error("GitHub returned an invalid API response.", { cause: error });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error("GitHub returned an invalid API response.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

async function fetchGithub(
  githubFetch: GithubFetch,
  url: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await githubFetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "iterate-os",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RetryableRepoCreationError("GitHub could not be reached.", { cause: error });
  }
  if (!response.ok) {
    const rateLimited =
      response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after"));
    const message = `GitHub returned HTTP ${response.status} while reading the config template.`;
    if (
      rateLimited ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new RetryableRepoCreationError(message);
    }
    throw new Error(message);
  }
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      throw new RetryableRepoCreationError("GitHub interrupted the config template response.", {
        cause: error,
      });
    }
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`GitHub returned more than ${maximumBytes} bytes for one response.`);
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
