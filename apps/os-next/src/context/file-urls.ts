// file-urls.ts — SIGNED FILE URLS, apps/os's way (its `iterate-files--<project>` host, lean): a URL on
// the project host `files--<project>.<base>` whose ONE query parameter is a signed claim over
// `{ project, key, method, exp }` (principal.ts `signClaims`, the platform's session secret), served
// at ingress straight from the bucket — a download (`GET`/`HEAD`, Range honoured) or an upload
// (`PUT`, the body stored under the key with the request's content type). The signature IS the
// authorization: no session, no cookie; the project cannot be escaped because the key is signed with
// the owner's prefix applied at ingress, never taken from the URL's host or path alone. No S3
// credentials, works locally (the e2e worker serves project hosts under `localhost`); the price is
// that bytes flow through the worker, bounded by the request-body limit.
import { z } from "zod";
import { signClaims, verifyClaims } from "../principal.ts";

/** What a signed file URL carries: the project it belongs to, the object key (owner prefix NOT
 *  included — ingress applies it), the one method it permits, and when it stops working. */
const FileUrlClaims = z.object({
  kind: z.literal("file-url"),
  project: z.string().min(1),
  key: z.string().min(1),
  method: z.enum(["GET", "PUT"]),
  exp: z.number().int().positive(),
});

export const DEFAULT_FILE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The reserved app label a signed file URL hangs under: `files--<project>.<base>`. */
export const FILES_APP_LABEL = "files";

/** Mint a signed URL for `key` in `project`'s slice of the bucket. Refused without a project-host
 *  base (a deployment with no project ingress cannot serve one). */
export async function signedFileUrl(input: {
  secret: string;
  platformOrigin: string;
  projectHostnameBase: string;
  project: string;
  key: string;
  method: "GET" | "PUT";
  expiresInSeconds?: number;
}): Promise<{ url: string; expiresAt: string }> {
  if (!input.projectHostnameBase)
    throw new Error("files: this deployment has no project-host ingress to serve a signed URL on");
  // The whole sum floored: the claim's `exp` is an integer, whatever TTL a caller spelled.
  const exp = Math.floor(
    Date.now() / 1000 + (input.expiresInSeconds ?? DEFAULT_FILE_URL_TTL_SECONDS),
  );
  const token = await signClaims(
    { kind: "file-url", project: input.project, key: input.key, method: input.method, exp },
    input.secret,
  );
  const { protocol } = new URL(input.platformOrigin);
  const path = input.key.split("/").map(encodeURIComponent).join("/");
  return {
    url: `${protocol}//${FILES_APP_LABEL}--${input.project}.${input.projectHostnameBase}/${path}?token=${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Serve one request on the files host: the token names the key, the method and the deadline; the
 *  request must match all three. `GET`/`HEAD` answer the object (a Range request gets its 206),
 *  `PUT` stores the body. Every refusal is terse — a URL is a bearer, and a bearer learns nothing. */
export async function serveProjectFileRequest(input: {
  bucket: R2Bucket;
  secret: string;
  /** The project the host named (admitted by the directory) — the claim must name the same one. */
  project: string;
  /** The owner prefix every key of this project lives under (built-ins.ts `r2Prefix`). */
  keyPrefix: string;
  request: Request;
}): Promise<Response> {
  const { request } = input;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("a signed file URL carries ?token=…\n", { status: 400 });
  const parsed = FileUrlClaims.safeParse(await verifyClaims(token, input.secret));
  if (!parsed.success) return new Response("Forbidden\n", { status: 403 });
  const claims = parsed.data;
  const requestKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (
    claims.project !== input.project ||
    claims.key !== requestKey ||
    claims.method !== method ||
    claims.exp * 1000 <= Date.now()
  )
    return new Response("Forbidden\n", { status: 403 });
  const key = input.keyPrefix + claims.key;

  if (claims.method === "PUT") {
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const object = await input.bucket.put(key, request.body, { httpMetadata: { contentType } });
    return Response.json({ path: `/${claims.key}`, contentType, size: object.size });
  }
  // The range only when the request asks for one: handed the headers regardless, the bucket reports
  // a range on a whole-object read too, and the answer would read as partial.
  const rangeHeader = request.headers.get("range");
  const object = await input.bucket.get(key, rangeHeader ? { range: request.headers } : {});
  if (!object) return new Response("Not found\n", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  let status = 200;
  const range = rangeHeader ? object.range : undefined;
  if (range && "offset" in range) {
    const offset = range.offset ?? 0;
    const length = range.length ?? object.size - offset;
    headers.set(
      "content-range",
      `bytes ${String(offset)}-${String(offset + length - 1)}/${String(object.size)}`,
    );
    headers.set("content-length", String(length));
    status = 206;
  } else if (range && "suffix" in range) {
    const length = Math.min(range.suffix, object.size);
    headers.set(
      "content-range",
      `bytes ${String(object.size - length)}-${String(object.size - 1)}/${String(object.size)}`,
    );
    headers.set("content-length", String(length));
    status = 206;
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
