// Step 08 — auth & access: scoped by the projects you actually have access to.
//
// A bearer token names a principal; the principal may access a set of projects;
// the itx you are handed is scoped to ONE project, and only if your token grants
// it. This is the real access boundary — without it anyone who can open the
// socket reaches every context.
//
// A real system looks the principal's project access up from an auth service
// (and the token is a signed JWT). Here it's a static map and a plain string —
// the CHECK is the point, not the store. server.ts mounts this at
// /steps/08-auth?project=<id> and only completes the WebSocket if authorize() ok.

export const PRINCIPALS: Record<string, { name: string; projects: string[] }> = {
  "alice-token": { name: "alice", projects: ["alice", "shared"] },
  "bob-token": { name: "bob", projects: ["bob", "shared"] },
};

export type AuthResult =
  | { ok: true; principal: string }
  | { ok: false; status: 401 | 403; message: string };

/** Authenticate the upgrade request, then check the principal may reach `project`. */
export function authorizeProjectAccess(request: Request, project: string): AuthResult {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const principal = PRINCIPALS[token];
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
