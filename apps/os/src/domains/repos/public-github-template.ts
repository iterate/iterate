import {
  isSafeConfigRepoTemplatePath,
  type ConfigRepoTemplateReference,
} from "../../lib/config-repo-template-reference.ts";
import {
  demuxFetchResponse,
  encodeFetchRequest,
  encodeLsRefsRequest,
  parseCommit,
  parseLsRefs,
  parsePack,
  parseTree,
  type RawGitObject,
} from "./git-wire.ts";
import { RetryableRepoCreationError } from "./utils.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const MAX_GITHUB_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Copy a public GitHub repository folder without GitHub credentials. The Git
 * smart-HTTP protocol gives us the exact ref's tree graph in one blobless
 * request, then every selected file in one batch request. That keeps the
 * source immutable without REST/raw request fan-out or its anonymous quota.
 */
export async function downloadPublicGithubTemplate(
  reference: ConfigRepoTemplateReference,
  githubFetch: GithubFetch = globalThis.fetch,
): Promise<Array<{ content: string; path: string }>> {
  const repository = `${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
  const endpoint = `https://github.com/${repository}.git/git-upload-pack`;
  const requestedRef = reference.ref ?? "HEAD";
  const commitOid = SHA_PATTERN.test(requestedRef)
    ? requestedRef
    : await resolveGithubRef(githubFetch, endpoint, requestedRef);
  const graph = await fetchGithubObjects(
    githubFetch,
    endpoint,
    encodeFetchRequest({ deepen: 1, filter: "blob:none", wants: [commitOid] }),
    { maxObjectBytes: MAX_TEMPLATE_BYTES, maxTotalObjectBytes: MAX_TEMPLATE_BYTES },
  );
  const objectsByOid = new Map(graph.map((object) => [object.oid, object]));
  const commit = objectsByOid.get(commitOid);
  if (commit?.type !== "commit") {
    throw new Error("GitHub did not return the requested template commit.");
  }

  let selectedTree = requireTree(objectsByOid, parseCommit(commit.payload).tree);
  for (const segment of reference.path?.split("/") ?? []) {
    const entry = parseTree(selectedTree.payload).find((candidate) => candidate.name === segment);
    if (entry?.mode !== "40000") {
      throw new Error(`Config template folder ${JSON.stringify(reference.path)} was not found.`);
    }
    selectedTree = requireTree(objectsByOid, entry.oid);
  }

  const files: Array<{ oid: string; path: string }> = [];
  const pending = [{ path: "", tree: selectedTree }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of parseTree(current.tree.payload)) {
      const path = current.path === "" ? entry.name : `${current.path}/${entry.name}`;
      if (entry.mode === "40000") {
        pending.push({ path, tree: requireTree(objectsByOid, entry.oid) });
        continue;
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw new Error(`Config templates cannot contain submodules or symbolic links (${path}).`);
      }
      if (!isSafeConfigRepoTemplatePath(path)) {
        throw new Error(
          `The selected config template contains an unsafe path: ${JSON.stringify(path)}.`,
        );
      }
      files.push({ oid: entry.oid, path });
      if (files.length > MAX_FILE_COUNT) {
        throw new Error(`The selected config template contains more than ${MAX_FILE_COUNT} files.`);
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error("The selected config template contains no files.");

  const blobs = await fetchGithubObjects(
    githubFetch,
    endpoint,
    encodeFetchRequest({ wants: [...new Set(files.map((file) => file.oid))] }),
    { maxObjectBytes: MAX_FILE_BYTES, maxTotalObjectBytes: MAX_TEMPLATE_BYTES },
  );
  const blobsByOid = new Map(blobs.map((object) => [object.oid, object]));
  return files.map((file) => {
    const blob = blobsByOid.get(file.oid);
    if (blob?.type !== "blob") {
      throw new Error(`GitHub did not return template file ${JSON.stringify(file.path)}.`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(blob.payload);
    } catch (error) {
      throw new Error(`Config template file ${JSON.stringify(file.path)} is not UTF-8 text.`, {
        cause: error,
      });
    }
    return { content, path: file.path };
  });
}

async function resolveGithubRef(
  githubFetch: GithubFetch,
  endpoint: string,
  requestedRef: string,
): Promise<string> {
  const prefixes = requestedRef.startsWith("refs/")
    ? [requestedRef]
    : requestedRef === "HEAD"
      ? ["HEAD"]
      : [`refs/heads/${requestedRef}`, `refs/tags/${requestedRef}`, `refs/${requestedRef}`];
  const body = await fetchGithub(githubFetch, endpoint, encodeLsRefsRequest({ prefixes }));
  const refs = parseLsRefs(body);
  const match = prefixes.map((prefix) => refs.find((entry) => entry.name === prefix)).find(Boolean);
  if (!match) throw new Error(`GitHub ref ${JSON.stringify(requestedRef)} was not found.`);
  return match.peeledOid ?? match.oid;
}

function requireTree(objectsByOid: Map<string, RawGitObject>, oid: string): RawGitObject {
  const object = objectsByOid.get(oid);
  if (object?.type !== "tree") {
    throw new Error("GitHub returned an incomplete template tree.");
  }
  return object;
}

async function fetchGithubObjects(
  githubFetch: GithubFetch,
  endpoint: string,
  request: Uint8Array,
  limits: { maxObjectBytes: number; maxTotalObjectBytes: number },
): Promise<RawGitObject[]> {
  const response = await fetchGithub(githubFetch, endpoint, request);
  return parsePack(demuxFetchResponse(response).pack, limits);
}

async function fetchGithub(
  githubFetch: GithubFetch,
  endpoint: string,
  request: Uint8Array,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await githubFetch(endpoint, {
      // Workers fetch accepts a Uint8Array body; BodyInit's lib.dom type is
      // narrower because Uint8Array may have a SharedArrayBuffer backing.
      body: request as BodyInit,
      headers: {
        Accept: "application/x-git-upload-pack-result",
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        "User-Agent": "git/2.45.0 (iterate-config-template)",
      },
      method: "POST",
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
  if (response.body === null) return new Uint8Array();

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
    if (totalBytes > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`GitHub returned more than ${MAX_GITHUB_RESPONSE_BYTES} bytes.`);
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
