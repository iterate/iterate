// Project ingress — the control plane resolves a project HOST to a projectId via the D1 directory (the
// routes table) and resolves the caller's MEMBERSHIP of that project. The front-desk half: identity +
// routing + membership.
//
// (The DIAL half — `dialProjectWorker` over the RUNNER service binding or the cross-account HTTP POST
// /serve — was deleted in clean-room increment cook-1 along with the project worker's pre-skeleton runner
// (`ProjectRunner` / `/serve`). Serving a resolved project returns via the capability host in a later
// control-plane increment.)

import type { Env } from "./env.ts";
import { directory } from "./directory.ts";

/** The non-secret caller identity + THIS project's membership (unforgeable by the browser — the control
 *  plane recomputes it on every ingress). A private app reads `member` via itx.auth. */
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
