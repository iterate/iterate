export const WORKER_VERSION_RESPONSE_HEADER = "x-iterate-worker-version";

/**
 * Stamp server-rendered app documents with the immutable Worker version that
 * produced their asset references. Preview readiness uses this on a real SSR
 * response; a health route and a build-time asset inventory cannot detect an
 * edge that still serves old HTML alongside the new deployment's assets.
 */
export function stampHtmlWorkerVersion(response: Response, version: string): Response {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/html") return response;

  const headers = new Headers(response.headers);
  headers.set(WORKER_VERSION_RESPONSE_HEADER, version);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
