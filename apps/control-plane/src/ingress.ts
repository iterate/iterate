// Project ingress — the control plane resolves a project HOST to a projectId via the D1 directory (the
// routes table, then the `<slug>.<base>` convention), then DIALS the project worker to run it. This is the
// front-desk half of the two-worker split: the control plane owns identity + routing; the project worker
// owns execution. The dial is HTTP + a shared secret, which works cross-Cloudflare-account (topology 4).

import { directory } from "./directory.ts";
import type { Env } from "./env.ts";

/** Resolve a project host → { projectId, app } via the directory routes table, else null. */
export async function resolveHost(
  host: string,
  env: Env,
): Promise<{ projectId: string; app: string } | null> {
  return directory(env.DB).resolveRoute(host);
}

/** Dial the project worker over HTTP to serve `projectId`. `caller` is the non-secret published identity. */
export async function dialProjectWorker(
  env: Env,
  projectId: string,
  app: string,
  path: string,
  caller: unknown,
): Promise<Response> {
  if (!env.PROJECT_WORKER_URL || !env.RUNNER_DIAL_SECRET) {
    return new Response("project worker not configured\n", { status: 503 });
  }
  return fetch(new URL("/serve", env.PROJECT_WORKER_URL), {
    method: "POST",
    headers: {
      "x-iterate-dial-secret": env.RUNNER_DIAL_SECRET,
      "x-iterate-project-id": projectId,
      "x-iterate-app": app,
      "x-iterate-path": path,
      "x-iterate-caller": JSON.stringify(caller),
    },
  });
}
