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
// Tokens are intentionally a tiny JSON subset of apps/os' principal shape
// (`type: "admin"` or a user with project scopes). The auth boundary linearizes
// that to the SAME shape apps/os uses for itx (`ProjectAccess = "all" |
// string[]`, see apps/os/src/itx/access.ts).
//
// Node and CLI clients open `/api/itx`, then pass credentials to
// `UnauthenticatedItx.authenticate(...)` as RPC data. Browser tests can fake a
// login through `/api/login`, then authenticate with `{ type:
// "from-server-cookie" }`. A real system resolves principal → access from the
// auth service's JWT/session shape; here the token already is that dummy data.

import type { ItxAuth, ItxAuthToken } from "./domains/itx/types.ts";

export const ITX_AUTH_COOKIE = "minimal-itx-auth";
export const TRUSTED_INTERNAL_ITX_TOKEN = "trusted-internal-itx-token";

export class FakeAuthContext implements ItxAuth {
  constructor(readonly token: ItxAuthToken) {}

  get principal(): string {
    return this.token.type === "admin" ? (this.token.principal ?? "admin") : this.token.principal;
  }

  isAdmin(): boolean {
    return this.token.type === "admin";
  }

  canAccessProject(projectId: string): boolean {
    return this.token.type === "admin" || this.token.projectScopes.includes(projectId);
  }

  assertCanAccessProject(projectId: string | null): void {
    if (projectId === null) {
      if (!this.isAdmin()) {
        throw new Error(`principal "${this.principal}" cannot access the platform project`);
      }
      return;
    }

    if (!this.canAccessProject(projectId)) {
      throw new Error(`principal "${this.principal}" has no access to project "${projectId}"`);
    }
  }

  listAccessibleProjects(): string[] {
    return this.token.type === "admin" ? [] : this.token.projectScopes;
  }
}

export function parseItxAuthToken(json: string): ItxAuthToken {
  return JSON.parse(json) as ItxAuthToken;
}

export function trustedInternalAuthContext(): ItxAuth {
  return new FakeAuthContext({ principal: "trusted-internal", type: "admin" });
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}
