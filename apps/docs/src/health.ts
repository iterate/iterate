import type { AppEnv } from "./env.ts";

const workerVersionHeader = "x-iterate-worker-version";

export function docsHealthResponse(env: Pick<AppEnv, "CF_VERSION_METADATA">): Response {
  return new Response("ok", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain",
      [workerVersionHeader]: env.CF_VERSION_METADATA?.id ?? "unversioned",
    },
  });
}
