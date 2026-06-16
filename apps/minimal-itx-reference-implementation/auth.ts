// auth.ts — the access boundary at the connect door.
//
// itx itself is unauthed WITHIN a connection (one `dial`, no per-capability
// gating). The trust boundary is the socket handshake: a bearer token names a
// principal, the principal may reach a set of projects, and the server only
// completes the WebSocket if the requested context is in reach.
//
// A real system resolves principal → project access from an auth service and
// the token is a signed JWT. Here it is a static map and a plain string — the
// CHECK is the point, not the store.

export const PRINCIPALS: Record<string, { name: string; projects: string[] }> = {
  "alice-token": { name: "alice", projects: ["alice", "shared"] },
  "bob-token": { name: "bob", projects: ["bob", "shared"] },
};

/** Every project any principal could reach — the full catalog the global root
 *  scopes down to per principal. Derived from the auth map so it never drifts. */
export const KNOWN_PROJECTS = [...new Set(Object.values(PRINCIPALS).flatMap((p) => p.projects))];

export type AuthResult =
  | { ok: true; principal: string }
  | { ok: false; status: 401 | 403; message: string };

/** Authenticate the upgrade request to a principal — WITHOUT a project. The
 *  global root is not project-scoped, so it only needs to know WHO you are (and
 *  which projects you may reach). */
export function authenticate(request: Request): { name: string; projects: string[] } | null {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return PRINCIPALS[token] ?? null;
}

/** Authenticate, then check the principal may reach `project`. */
export function authorizeProjectAccess(request: Request, project: string): AuthResult {
  const principal = authenticate(request);
  if (!principal) return { ok: false, status: 401, message: "missing or invalid token" };
  if (!project) return { ok: false, status: 403, message: "no project specified" };
  if (!principal.projects.includes(project)) {
    return {
      ok: false,
      status: 403,
      message: `principal "${principal.name}" has no access to project "${project}"`,
    };
  }
  return { ok: true, principal: principal.name };
}
