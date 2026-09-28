import {
  isSafeConfigRepoTemplatePath,
  type ConfigRepoTemplateReference,
} from "@iterate-com/shared/config-repo-template/reference";
import {
  demuxFetchResponse,
  encodeFetchRequest,
  encodeLsRefsRequest,
  manifestOf,
  parseCommit,
  parseLsRefs,
  parsePack,
  parseTree,
  type RawGitObject,
} from "./git-wire.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const MAX_GITHUB_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Resolve a template's mutable ref before recording the durable creation request. */
export async function pinPublicGithubTemplate(
  reference: ConfigRepoTemplateReference,
  githubFetch: GithubFetch = globalThis.fetch,
): Promise<ConfigRepoTemplateReference> {
  const requestedRef = reference.ref || "HEAD";
  if (SHA_PATTERN.test(requestedRef)) return reference;
  const repository = `${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
  const ref = await resolveGithubRef(
    githubFetch,
    `https://github.com/${repository}.git/git-upload-pack`,
    requestedRef,
  );
  return { ...reference, ref };
}

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
  const requestedRef = reference.ref || "HEAD";
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

  const manifest = manifestOf(parseTree(selectedTree.payload), objectsByOid);
  if (manifest.size > MAX_FILE_COUNT) {
    throw new Error(`The selected config template contains more than ${MAX_FILE_COUNT} files.`);
  }
  const files = [...manifest].map(([path, entry]) => {
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`Config templates cannot contain submodules or symbolic links (${path}).`);
    }
    if (!isSafeConfigRepoTemplatePath(path)) {
      throw new Error(
        `The selected config template contains an unsafe path: ${JSON.stringify(path)}.`,
      );
    }
    return { oid: entry.oid, path };
  });
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
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(blob.payload);
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
  const refs = parseLsRefs(await fetchGithub(githubFetch, endpoint, encodeLsRefsRequest(prefixes)));
  const match = prefixes.map((prefix) => refs.find((entry) => entry.name === prefix)).find(Boolean);
  if (!match) throw new Error(`GitHub ref ${JSON.stringify(requestedRef)} was not found.`);
  return match.peeledOid || match.oid;
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
  return parsePack(demuxFetchResponse(response), limits);
}

async function fetchGithub(
  githubFetch: GithubFetch,
  endpoint: string,
  request: Uint8Array,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await githubFetch(endpoint, {
      // Copy into an ArrayBuffer-backed view accepted by both Node and Workers fetch.
      body: new Uint8Array(request),
      headers: {
        Accept: "application/x-git-upload-pack-result",
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        "User-Agent": "git/2.45.0 (iterate-config-template)",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error("GitHub could not be reached.", { cause: error });
  }
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} while reading the config template.`);
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch (error) {
      throw new Error("GitHub interrupted the config template response.", { cause: error });
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
