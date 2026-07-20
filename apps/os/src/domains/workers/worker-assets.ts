import type { WorkerBuildOptions } from "./schemas.ts";

/** The output pathname convention used by worker-bundler's single client entry. */
export function workerClientAssetPath(options: WorkerBuildOptions | undefined): string | null {
  return options?.clientEntryPoint === undefined ? null : "/client.js";
}

/** Avoid resolving a stateful worker merely to discover that an ordinary app
 * request is not for its one host-served browser bundle. */
export function isWorkerClientAssetRequest(
  request: Request,
  options: WorkerBuildOptions | undefined,
): boolean {
  const pathname = workerClientAssetPath(options);
  return (
    pathname !== null &&
    (request.method === "GET" || request.method === "HEAD") &&
    new URL(request.url).pathname === pathname
  );
}

/** Serve exact worker-bundler asset pathnames from the host. These bytes are
 * deliberately not embedded in, or loaded into, the dynamic Worker isolate. */
export function workerAssetResponse(
  request: Request,
  assets: Record<string, string>,
): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  const content = assets[pathname];
  if (content === undefined) return null;
  return new Response(request.method === "HEAD" ? null : content, {
    headers: {
      "cache-control": "no-cache",
      "content-type": pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
