// auth.ts — the access boundary, and the ONLY authority decision in the system.
//
// The whole model is one line: you are either an admin (`access: "all"`, may
// reach anything, nobody cares) OR you hold a list of project ids and may reach
// exactly those. There is no per-capability gating anywhere downstream — once
// the connect door lets you into a project context, everything inside it is
// confined BY CONSTRUCTION: built-ins name only that project, the chain tops out
// at that project (there is no global catalog to climb to), and user-provided
// capabilities cannot name another project's Durable Object (server/itx reject
// the dialer address types). So authority lives here, at the door, and nowhere
// else.
//
// `access` is intentionally the SAME shape apps/os linearizes a principal to
// (`ProjectAccess = "all" | string[]`, see apps/os/src/itx/access.ts) — this is a
// faithful subset, not a parallel invention.
//
// Node and CLI clients send `Authorization: Bearer ...`. Browsers cannot set
// headers on a WebSocket upgrade, so the reference browser client may send the
// same demo token as `?token=...`. A real system resolves principal → access
// from an auth service and the token is a signed JWT; here it is a static map and
// a plain string — the CHECK is the point, not the store.

/** Admin (everything) or an explicit list of reachable project ids. */
export type Access = "all" | string[];

export type Principal = { name: string; access: Access };

export const PRINCIPALS: Record<string, Principal> = {
  "alice-token": { name: "alice", access: ["alice", "shared"] },
  "bob-token": { name: "bob", access: ["bob", "shared"] },
  // An admin: reaches any project, and is the only principal allowed at the
  // admin-only Root ITX (`/api/root`).
  "root-token": { name: "root", access: "all" },
};

/** Every project a non-admin principal lists — the catalog the Root ITX hands
 *  back from `projects.list()`. Derived from the auth map so it never drifts. */
export const KNOWN_PROJECTS = [
  ...new Set(Object.values(PRINCIPALS).flatMap((p) => (p.access === "all" ? [] : p.access))),
];

export type AuthResult =
  | { ok: true; principal: string; access: Access }
  | { ok: false; status: 401 | 403; message: string };

/** Authenticate the request to a principal (WITHOUT a project). The Root ITX
 *  uses this directly and then checks `access === "all"`. */
export function authenticate(request: Request): Principal | null {
  const headerToken = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const queryToken = new URL(request.url).searchParams.get("token") ?? "";
  const token = headerToken || queryToken;
  return PRINCIPALS[token] ?? null;
}

/** Authenticate, then check the principal may reach `project`. Admins ("all")
 *  reach any project; everyone else must list it. */
export function authorizeProjectAccess(request: Request, project: string): AuthResult {
  const principal = authenticate(request);
  if (!principal) return { ok: false, status: 401, message: "missing or invalid token" };
  if (!project) return { ok: false, status: 403, message: "no project specified" };
  if (principal.access !== "all" && !principal.access.includes(project)) {
    return {
      ok: false,
      status: 403,
      message: `principal "${principal.name}" has no access to project "${project}"`,
    };
  }
  return { ok: true, principal: principal.name, access: principal.access };
}
