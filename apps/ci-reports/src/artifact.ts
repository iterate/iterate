import {
  Reader,
  ZipReader,
  ERR_UNSAFE_FILENAME,
  configure,
} from "@zip.js/zip.js/lib/zip-core-native.js";
import mime from "mime";
import { z } from "zod";

/**
 * `/<artifact-id>/<file>`: one file of a public Depot CI artifact of iterate/iterate, read out of
 * Depot's ZIP with range requests. `/<artifact-id>/` opens the artifact's report — `trace.html` for
 * a CI trace, the root `index.html` for a Playwright report — redirects to its only file, or lists
 * its files. An artifact is public when its name starts with `public-` (docs/ci-traces.md).
 *
 * Misha's viewer from the iterate/config project (`apps/depot/artifact.ts`, #2681 and #2690), itself
 * adapted from artifact.ci's resolve-filepath.ts and build-file-response.ts
 * (https://github.com/mmkal/artifact.ci/tree/main/packages/domain/src/artifact). That viewer gave
 * each artifact its own origin under the platform's `*.iterate.app` wildcard; this Worker has one
 * workers.dev origin, so each artifact gets a path, and its CSP confines the page to that path.
 */
export async function serveDepotArtifact(
  request: Request,
  { token, fetch: fetchArtifact }: { token: string; fetch: typeof fetch },
) {
  const url = new URL(request.url);
  const route = url.pathname.match(/^\/([a-f0-9-]{36})(\/.*)?$/);
  if (!route) return new Response("Not found", { status: 404 });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const [, artifactId, rest] = route;
  // A report's relative links (Playwright's `data/…`, `trace/…`) resolve against its directory.
  if (!rest) return Response.redirect(`${url.origin}/${artifactId}/${url.search}`, 302);
  const base = `${url.origin}/${artifactId}/`;
  let file: string;
  try {
    file = decodeURIComponent(rest.slice(1));
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  if (file && !safePath(file)) return new Response("Invalid path", { status: 400 });
  const download = await fetchArtifact(
    "https://api.depot.dev/depot.ci.v1.CIService/GetArtifactDownloadURL",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-depot-org": "0p91s0lz49",
      },
      body: JSON.stringify({ artifactId }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (download.status === 404)
    return new Response("Artifact not found or expired", { status: 404 });
  if (!download.ok) throw new Error(`Depot artifact lookup returned HTTP ${download.status}`);
  const result = z
    .object({
      artifact: z.object({
        artifactId: z.string(),
        workflowId: z.string(),
        name: z.string(),
        sizeBytes: z.coerce.number().nonnegative(),
      }),
      url: z.url().startsWith("https://"),
    })
    .parse(await download.json());
  const workflow = await fetchArtifact("https://api.depot.dev/depot.ci.v1.CIService/GetWorkflow", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-depot-org": "0p91s0lz49",
    },
    body: JSON.stringify({ workflowId: result.artifact.workflowId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!workflow.ok) throw new Error(`Depot workflow lookup returned HTTP ${workflow.status}`);
  const source = z.object({ repo: z.string() }).parse(await workflow.json());
  if (
    source.repo !== "iterate/iterate" ||
    result.artifact.artifactId !== artifactId ||
    !result.artifact.name.startsWith("public-")
  )
    return new Response("Not a public artifact", { status: 404 });
  // Fetch only the ZIP directory and the chosen entry. Large trace/video files
  // must not force every report page to download the entire artifact into memory.
  const reader = new Reader(result.url);
  reader.size = result.artifact.sizeBytes;
  reader.readUint8Array = async (offset, length) => {
    // Entry data arrives in `chunkSize` reads (configured below), so only a ZIP directory this
    // large, read in one piece, reaches the cap.
    if (length > 8 * 1024 * 1024) throw new Error("Artifact ZIP directory exceeds 8 MiB");
    const end = Math.min(offset + length, reader.size) - 1;
    const response = await fetchArtifact(result.url, {
      headers: { range: `bytes=${offset}-${end}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !== `bytes ${offset}-${end}/${reader.size}`
    ) {
      await response.body?.cancel();
      throw new Error(`Depot did not return the requested byte range: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  // With native streams there are no web workers to ration. zip.js still uses a
  // global two-slot queue by default in Workers; a slow response then blocks
  // unrelated requests (and queues their I/O behind another request's lifetime).
  configure({ chunkSize: 1024 * 1024, maxWorkers: Number.MAX_SAFE_INTEGER });
  const zip = new ZipReader(reader, { useWebWorkers: false, useCompressionStream: true });
  const archiveEntries = await zip.getEntries().catch((error) => {
    if (error instanceof Error && error.message === ERR_UNSAFE_FILENAME) return null;
    throw error;
  });
  if (!archiveEntries) return new Response("Artifact contains unsafe paths", { status: 422 });
  const files = archiveEntries
    .filter((entry) => !entry.directory)
    .filter((entry) => safePath(entry.filename));
  const entries = files.map((entry) => entry.filename);
  if (!file) {
    if (result.artifact.name.startsWith("public-ci-trace-")) file = "trace.html";
    else if (entries.includes("index.html") || entries.length !== 1) file = "index.html";
    else return Response.redirect(`${base}${encodePath(entries[0])}${url.search}`, 302);
  }
  const directoryIndex = `${file.replace(/\/$/, "")}/index.html`;
  if (file && !entries.includes(file) && entries.includes(directoryIndex))
    return Response.redirect(`${base}${encodePath(directoryIndex)}${url.search}`, 302);
  let generatedIndex = "";
  if (file === "index.html" && !entries.includes(file)) {
    const links = entries
      .sort()
      .map((name) => `<li><a href="${encodePath(name)}">${escapeHtml(name)}</a></li>`)
      .join("\n");
    generatedIndex = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(result.artifact.name)}</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#222}li{margin:12px 0;overflow-wrap:anywhere}a{color:#165dcc}</style><h1>${escapeHtml(result.artifact.name)}</h1><p>${entries.length} files</p><ul>${links}</ul>`;
  }
  const entry = files.find((entry) => entry.filename === file);
  if (!entry && !generatedIndex) return new Response("Artifact file not found", { status: 404 });
  if (entry && entry.uncompressedSize > 512 * 1024 * 1024)
    return new Response("Artifact file exceeds 512 MiB", { status: 413 });
  let body: BodyInit | null = request.method === "HEAD" ? null : generatedIndex;
  if (entry && request.method !== "HEAD") {
    let controller: TransformStreamDefaultController;
    const stream = new TransformStream({
      start(value) {
        controller = value;
      },
    });
    // ZIP local-header reads can fail before getData acquires the writable.
    // Error the response explicitly as well as retaining the cause in worker logs.
    void entry.getData(stream.writable).catch((error) => {
      controller.error(error);
      console.error("Artifact extraction failed", { artifactId, file, error });
    });
    body = stream.readable;
  }
  const contentType = file.endsWith(".log")
    ? "text/plain"
    : mime.getType(file) || "application/octet-stream";
  const inline =
    /^(text\/|image\/|audio\/|video\/)|^application\/(json|pdf|xml|javascript|yaml)$/.test(
      contentType,
    );
  const disposition = url.searchParams.has("download") || !inline ? "attachment" : "inline";
  const filename = encodeURIComponent(file.split("/").at(-1)!);
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `${disposition}; filename="${filename}"; filename*=UTF-8''${filename.replaceAll("'", "%27")}`,
      "content-length": String(
        entry ? entry.uncompressedSize : new TextEncoder().encode(generatedIndex).length,
      ),
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      // Every request stays inside this artifact's path: a source with a path matches that prefix
      // (https://www.w3.org/TR/CSP3/#match-paths). Playwright uses data: placeholders when swapping
      // its two snapshot frames. The origin holds no cookies or credentials to protect, and a
      // report's service worker (Playwright's trace viewer) is scoped to the directory of its script.
      "content-security-policy": `default-src 'none'; script-src ${base} 'unsafe-inline' 'wasm-unsafe-eval'; style-src ${base} 'unsafe-inline'; connect-src ${base} blob: data:; img-src ${base} blob: data:; media-src ${base} blob:; font-src ${base} data:; worker-src ${base} blob:; frame-src ${base} blob: about: data:; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox`,
      "referrer-policy": "no-referrer",
    },
  });
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function safePath(path: string) {
  return (
    !path.startsWith("/") &&
    !/[\\\p{Cc}]/u.test(path) &&
    !path.split("/").some((part) => part === ".." || part === ".")
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
