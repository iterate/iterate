// SSR's door into itx: an in-process handle, no socket, no Cap'n Web.
//
// TanStack Start loaders run inside the OS worker itself, so the server
// render never dials /api/itx — it mirrors exactly what fetch.ts does at
// WebSocket connect time (accessForPrincipal → resolveAccessibleContextId →
// resolveItx), minus the transport. The result is a plain `Itx` RpcTarget
// instance; calling its methods in-process is fine, and each built-in call is
// one Workers RPC to the owning DO — the same hop the browser path makes
// after its socket handshake.
//
// Access model (Law 3: auth happens where credentials become handles): the
// principal arrives on the request context, placed there by the iterate auth
// request middleware; this module is the auth boundary for the SSR door, so
// the access check lives HERE via the same shared helpers (access.ts) the
// /api/itx door uses — the two doors cannot drift.
//
// Server-only: imports cloudflare:workers and the db-backed access helpers.
// Loaders must reach this through getLoaderItx (loader.ts), whose server
// branch imports it dynamically so none of this enters the browser bundle.

import { env } from "cloudflare:workers";
import { resolveItx } from "./entrypoint.ts";
import type { Itx } from "./handle.ts";
import { accessForPrincipal, requireWorkerExports, resolveAccessibleContextId } from "./access.ts";
import { ItxError } from "./errors.ts";
import { requireRequestContext, type RequestContext } from "~/request-context.ts";

/**
 * A project-narrowed in-process itx handle for the current SSR request.
 *
 * Throws when there is no principal or the principal may not hold the target
 * project — same outcome (and same "not found" wording, no existence probing)
 * as connecting to /api/itx/:idOrSlug without access. Prefetch callers are
 * expected to treat that as "skip seeding", not as a route error — see
 * prefetchItxQuery in loader.ts.
 *
 * `requestContext` is for callers outside TanStack's request storage (the
 * worker-harness tests); inside a loader/server function the global start
 * context supplies it.
 */
export async function getServerItx(
  projectSlugOrId: string,
  requestContext?: RequestContext,
): Promise<Itx> {
  const context = requireRequestContext(requestContext);
  if (!context.principal) {
    // Byte-identical to the missing/forbidden message below: an
    // unauthenticated render must not be distinguishable from a denied one
    // (no probing), matching the kernel's masking posture (DECISIONS D18).
    throw new ItxError({
      code: "NOT_FOUND",
      details: { projectIdOrSlug: projectSlugOrId },
      message: `Project ${projectSlugOrId} not found.`,
    });
  }

  const resolved = await resolveAccessibleContextId({
    access: accessForPrincipal(context.principal),
    db: context.db,
    env,
    idOrSlug: projectSlugOrId,
  });
  if (!resolved) {
    throw new ItxError({
      code: "NOT_FOUND",
      details: { projectIdOrSlug: projectSlugOrId },
      message: `Project ${projectSlugOrId} not found.`,
    });
  }

  return await resolveItx({
    env,
    exports: requireWorkerExports(context),
    props: { context: resolved.contextId },
  });
}
