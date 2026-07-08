// project-files.ts — R2-backed project file storage (`itx.files`) plus the
// signed-URL plane that serves those bytes to any HTTP client.
//
// The design is two planes over one bucket:
//
// - **itx plane**: `itx.files.get(path)` handles (put/bytes/url/delete) for
//   programmatic callers — browser composer, agent scripts, server-side
//   processors. Bytes ride the existing capnweb/workers-rpc transports.
// - **HTTP plane**: any file is servable to any HTTP client (browser <img>,
//   Slack unfurls, LLM providers fetching image URLs) through the reserved
//   `iterate-files` platform app on the project hostname convention:
//   `https://iterate-files--<slug>.<base><path>?exp=...&sig=...`. The os
//   worker short-circuits this app slug at ingress (src/worker.ts) and serves
//   straight from the bucket after verifying the HMAC — bytes never touch the
//   project worker, and the scheme works identically on `*.localhost` dev
//   hosts where S3-style presigned URLs would point at nothing.
//
// Object keys reuse the durable-object name convention (`durable-object-names.ts`):
// `{projectId}.iterate{path}` — a key alone tells you which project owns the
// bytes, and files attached to an agent conversation live under that agent's
// path (`prj_x.iterate/agents/slack/T1/thr-9/abc12345-cat.png`).
//
// Paths are mutable, last-write-wins; URLs sign the path only (a re-upload is
// served to holders of an older still-valid link). Deliberately v1-simple: no
// versioning, no listing, no quotas. The pure pieces (byte coercion, HMAC,
// request verification) live in file-url-signing.ts so they unit-test in Node.

import { itxEnv } from "../../env.ts";
import type { AppConfig } from "../../config.ts";
import { readProjectById } from "../../project-directory.ts";
import { normalizeProjectHostnameBase } from "../../lib/project-host-routing.ts";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import {
  buildSignedFileUrl,
  checkSignedFileRequest,
  projectFileDataToBytes,
  sanitizeFileFilename as sanitizeName,
  type ProjectFileData,
} from "./file-url-signing.ts";

export { sanitizeFileFilename } from "./file-url-signing.ts";

/**
 * The reserved platform app slug that serves project file bytes. Ingress
 * already parses `<app>--<slug>.<base>` hosts; this app never reaches the
 * project worker — src/worker.ts serves it from the files bucket instead.
 */
export const FILES_APP_SLUG = "iterate-files";

/** Default signed-URL lifetime: long enough that a link pasted into Slack
 * still works next week, short enough that leaked links eventually die. */
const DEFAULT_FILE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

function fileObjectKey(input: { path: string; projectId: string }): string {
  return DurableObjectNameCodec.stringify({
    path: normalizePath(input.path),
    projectId: input.projectId,
  });
}

/** What a stored file looks like from the outside: address + wire facts. */
type ProjectFileMetadata = {
  contentType: string;
  path: string;
  size: number;
};

export async function putProjectFile(input: {
  contentType?: string;
  data: ProjectFileData;
  path: string;
  projectId: string;
}): Promise<ProjectFileMetadata> {
  const bytes = await projectFileDataToBytes(input.data);
  const contentType = input.contentType?.trim() || "application/octet-stream";
  await itxEnv.FILES_BUCKET.put(fileObjectKey(input), bytes, {
    httpMetadata: { contentType },
  });
  return { contentType, path: normalizePath(input.path), size: bytes.byteLength };
}

export async function readProjectFile(input: {
  path: string;
  projectId: string;
}): Promise<{ bytes: Uint8Array; contentType: string; size: number } | null> {
  const object = await itxEnv.FILES_BUCKET.get(fileObjectKey(input));
  if (object === null) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return {
    bytes,
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    size: bytes.byteLength,
  };
}

export async function deleteProjectFile(input: { path: string; projectId: string }): Promise<void> {
  await itxEnv.FILES_BUCKET.delete(fileObjectKey(input));
}

/**
 * Mints the signed public URL for a file. The hostname identifier prefers the
 * project slug (pretty) and falls back to the `prj_` id, which ingress
 * resolvers pass through just the same.
 */
export async function mintProjectFileUrl(input: {
  config: AppConfig;
  expiresInSeconds?: number;
  path: string;
  projectId: string;
}): Promise<string> {
  const record = await readProjectById(itxEnv.PROJECT_DIRECTORY, input.projectId);
  const identifier = record?.slug ?? input.projectId;
  const rawBase = input.config.projectHostnameBases?.[0];
  if (!rawBase) {
    throw new Error("Cannot mint a file URL: no project hostname base is configured.");
  }
  const base = normalizeProjectHostnameBase(rawBase);
  const host = `${FILES_APP_SLUG}--${identifier}.${base}`;

  // Loopback bases (local dev) have no DNS/TLS: inherit the app's own scheme
  // and port, same as buildProjectWorkerUrl.
  const isLoopback = base === "localhost" || base.endsWith(".localhost");
  let origin = `https://${host}`;
  if (isLoopback && input.config.baseUrl && URL.canParse(input.config.baseUrl)) {
    const appUrl = new URL(input.config.baseUrl);
    origin = `${appUrl.protocol}//${host}${appUrl.port ? `:${appUrl.port}` : ""}`;
  }

  return await buildSignedFileUrl({
    expiresAtSeconds:
      Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? DEFAULT_FILE_URL_TTL_SECONDS),
    origin,
    path: normalizePath(input.path),
    projectId: input.projectId,
    secret: itxEnv.SECRET_ENCRYPTION_KEY,
  });
}

/**
 * Stores files under an agent's own path and returns the attachment records
 * (path + signed url + wire facts) that ride on agent stream events. The one
 * storage recipe behind every attachment surface — `agent.addFiles` (inputs)
 * and `chat.sendMessage(message, { files })` (agent replies). A short random prefix
 * keeps two same-named uploads in one conversation from overwriting each
 * other under last-write-wins paths.
 */
export async function storeAgentFileAttachments(input: {
  agentPath: string;
  config: AppConfig;
  files: Array<{ contentType: string; data: ProjectFileData; filename: string }>;
  projectId: string;
}): Promise<Array<ProjectFileMetadata & { filename: string; url: string }>> {
  return await Promise.all(
    input.files.map(async (file) => {
      const filename = sanitizeName(file.filename);
      const path = `${input.agentPath}/${crypto.randomUUID().slice(0, 8)}-${filename}`;
      const metadata = await putProjectFile({
        contentType: file.contentType,
        data: file.data,
        path,
        projectId: input.projectId,
      });
      const url = await mintProjectFileUrl({
        config: input.config,
        path,
        projectId: input.projectId,
      });
      return { ...metadata, filename, url };
    }),
  );
}

/**
 * Serves one signed-URL request on the `iterate-files` lane. The projectId
 * comes from ingress host resolution (trusted); path, expiry, and HMAC are
 * verified by checkSignedFileRequest.
 */
export async function serveProjectFileRequest(input: {
  projectId: string;
  request: Request;
}): Promise<Response> {
  const { request } = input;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const check = await checkSignedFileRequest({
    nowMs: Date.now(),
    projectId: input.projectId,
    secret: itxEnv.SECRET_ENCRYPTION_KEY,
    url: new URL(request.url),
  });
  if (!check.ok) return new Response(check.message, { status: check.status });

  const object = await itxEnv.FILES_BUCKET.get(
    fileObjectKey({ path: check.path, projectId: input.projectId }),
  );
  if (object === null) return new Response("not found", { status: 404 });

  const filename = check.path.split("/").at(-1) ?? "file";
  const headers = new Headers({
    // Signed query-string auth makes the response origin-agnostic; CORS stays
    // wide open so browser fetch() works from the dashboard origin.
    "access-control-allow-origin": "*",
    "cache-control": "private, max-age=3600",
    "content-disposition": `inline; filename="${filename.replaceAll('"', "")}"`,
    "content-length": String(object.size),
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    etag: object.httpEtag,
  });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
