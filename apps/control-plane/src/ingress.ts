// Project ingress — the control plane resolves a project HOST to a projectId via the D1 directory (the
// routes table), resolves the caller's MEMBERSHIP of that project, then DIALS the project worker to run it.
// This is the front-desk half of the two-worker split: the control plane owns identity + routing +
// membership; the project worker owns execution. Two dial transports, one behavior:
//   • same account  → the RUNNER service binding (env.RUNNER.serve).
//   • cross account → HTTP POST /serve + a shared secret (service bindings don't cross CF accounts).

import type { Env } from "./env.ts";
import { directory } from "./directory.ts";

/** The non-secret caller identity + THIS project's membership, stamped through the dial (unforgeable by
 *  the browser — the control plane overwrites it; see app.ts). A private app reads `member` via itx.auth. */
export interface StampedCaller {
  actor: string;
  email: string;
  member: boolean;
  role: string | null;
}

/** Resolve a project host → { projectId, app } via the directory routes table, else null. */
export async function resolveHost(
  host: string,
  env: Env,
): Promise<{ projectId: string; app: string } | null> {
  return directory(env.DB).resolveRoute(host);
}

/** Resolve a caller's membership of a project (owner/member/none) — the input to private-app auth. */
export async function stampFor(
  actor: string,
  email: string,
  projectId: string,
  env: Env,
): Promise<StampedCaller> {
  const access =
    actor === "user_anonymous" ? { ok: false } : await directory(env.DB).access(actor, projectId);
  return { actor, email, member: access.ok, role: access.ok ? (access.role ?? "member") : null };
}

/** Dial the project worker to serve `projectId`. Prefers the same-account RUNNER binding; falls back to
 *  the cross-account HTTP dial. Both hand the runner the same (projectId, app, path, stamped caller). */
export async function dialProjectWorker(
  env: Env,
  projectId: string,
  app: string,
  path: string,
  caller: StampedCaller,
): Promise<Response> {
  const callerHeader = JSON.stringify(caller);
  const request = new Request(`https://runner.internal${path}`, {
    headers: {
      "x-iterate-project-id": projectId,
      "x-iterate-app": app,
      "x-iterate-caller": callerHeader,
      "x-iterate-cp-origin": env.CONTROL_PLANE_ORIGIN ?? "",
    },
  });

  if (env.RUNNER) return env.RUNNER.serve(request, projectId, app, callerHeader);

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
      "x-iterate-caller": callerHeader,
      "x-iterate-cp-origin": env.CONTROL_PLANE_ORIGIN ?? "",
    },
  });
}
