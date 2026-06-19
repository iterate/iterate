// auth.ts — the access boundary, and the ONLY authority decision in the system.
//
// The whole model is one line: you are either an admin (`access: "all"`, may
// reach any project) OR you hold a list of project ids and may reach exactly
// those. There is no per-capability gating anywhere downstream — once the
// connect door lets you into a project context, everything inside it is confined
// BY CONSTRUCTION: host capabilities name only that project, agents reach their
// project through an explicit host-owned member, and public durable addresses
// are only dynamic worker/facet descriptions. So authority lives in the
// ItxAuthContext every authenticated RPC target carries, and nowhere else.
//
// `access` is intentionally the SAME shape apps/os linearizes a principal to
// (`ProjectAccess = "all" | string[]`, see apps/os/src/itx/access.ts) — this is a
// faithful subset, not a parallel invention.
//
// Node and CLI clients open `/api/itx`, then pass credentials to
// `UnauthenticatedItx.authenticate(...)` as RPC data. Browser tests can fake a
// login through `/api/login`, then authenticate with `{ type:
// "from-server-cookie" }`. A real system resolves principal → access from the
// auth service's JWT/session shape; here it is a static map and a plain string —
// the CHECK is the point, not the store.

/** Admin (everything) or an explicit list of reachable project ids. */
export type Access = "all" | string[];

export type Principal = { name: string; access: Access };

export type ItxAuth =
  | { type: "from-server-cookie" }
  | { type: "token"; token: string }
  | { type: "trusted-internal"; token: string };

export interface ItxAuthContext {
  readonly principal: string;
  canCreateProject(): boolean;
  requireCanCreateProject(): void;
  canAccessProject(projectId: string): boolean;
  requireProjectAccess(projectId: string): void;
  listAccessibleProjects(): string[];
}

export const PRINCIPALS: Record<string, Principal> = {
  "alice-token": { name: "alice", access: ["prj_alice", "prj_ref"] },
  "bob-token": { name: "bob", access: ["prj_bob", "prj_ref"] },
  // An admin: reaches any project and can create projects.
  "root-token": { name: "root", access: "all" },
};

export const ITX_AUTH_COOKIE = "minimal-itx-auth";
export const TRUSTED_INTERNAL_ITX_TOKEN = "trusted-internal-itx-token";

/** Every project a non-admin principal lists — the catalog the authenticated
 *  global ITX hands back from `projects.list()`. Derived from the auth map so it
 *  never drifts. */
export const KNOWN_PROJECTS = [
  ...new Set(Object.values(PRINCIPALS).flatMap((p) => (p.access === "all" ? [] : p.access))),
];

export class StaticItxAuthContext implements ItxAuthContext {
  constructor(
    readonly principal: string,
    readonly access: Access,
  ) {}

  canCreateProject(): boolean {
    return this.access === "all";
  }

  requireCanCreateProject(): void {
    if (!this.canCreateProject()) {
      throw new Error(`principal "${this.principal}" cannot create projects`);
    }
  }

  canAccessProject(projectId: string): boolean {
    return this.access === "all" || this.access.includes(projectId);
  }

  requireProjectAccess(projectId: string): void {
    if (!projectId) throw new Error("no project specified");
    if (!this.canAccessProject(projectId)) {
      throw new Error(`principal "${this.principal}" has no access to project "${projectId}"`);
    }
  }

  listAccessibleProjects(): string[] {
    return this.access === "all" ? KNOWN_PROJECTS : this.access;
  }
}

export function authContextForPrincipal(principal: Principal): ItxAuthContext {
  return new StaticItxAuthContext(principal.name, principal.access);
}

export function trustedInternalAuthContext(): ItxAuthContext {
  return new StaticItxAuthContext("trusted-internal", "all");
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}
