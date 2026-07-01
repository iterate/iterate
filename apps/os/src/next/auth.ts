// auth.ts — the access boundary, and the ONLY authority decision in the system.
//
// The whole model is one line: you are either an admin (may reach any project)
// OR you hold a list of project ids and may reach exactly those. There is no
// per-capability gating anywhere downstream — once the connect door lets you
// into a project context, everything inside it is confined BY CONSTRUCTION:
// host capabilities name only that project, agents reach their project through
// an explicit host-owned member, and public durable addresses are only dynamic
// worker/facet descriptions. So authority lives in the ItxAuthContext every
// authenticated RPC target carries, and nowhere else.
//
// Credential lanes (see resolveItxAuth):
//   from-server-cookie — the browser lane: the `iterate-admin-auth` admin
//     cookie, else the `iterate_session` cookie verified against the auth
//     worker's JWKS. Project scopes come from the session's project claims.
//   bearer            — an auth-worker access token presented as RPC data.
//   admin-secret      — APP_CONFIG_ADMIN_API_SECRET; the CLI/e2e/tooling lane.
//   impersonate       — admin-secret-gated fake principal (tests): lets suites
//     exercise user-vs-user confinement against any deployment without minting
//     real users.
//
// Stale-claims: a session's project claims lag reality right after a project
// is created. `ensureCanAccessProject` treats claims as the fast path and the
// auth worker's directory as the source of truth — one cached membership
// lookup widens the live context instead of forcing a token refresh.

import { authenticateCapnwebAdmin } from "../auth/admin-auth-cookie.ts";
import { authenticateAdminBearer } from "../auth/admin.ts";
import { createAuthWorkerServiceClient } from "../auth/auth-worker-service.ts";
import { createOsIterateAuth } from "../auth/iterate-auth-client.ts";
import {
  principalFromAccessToken,
  principalFromSession,
  principalIsAdmin,
  type Principal,
  type UserPrincipal,
} from "../auth/principal.ts";
import type { AppConfig } from "../config.ts";
import type { ItxAuth, ItxAuthCredentials, ItxAuthToken } from "./types.ts";

/**
 * Kept for the engine e2e suites, which express "run this as a fake user with
 * these scopes" via test-helpers. On the wire those become `impersonate`
 * credentials gated on the admin API secret.
 */
export const TRUSTED_INTERNAL_ITX_TOKEN = "trusted-internal-itx-token";

type ProjectDirectory = {
  userHasProject(userPrincipal: UserPrincipal, projectId: string): Promise<boolean>;
};

export class ItxAuthContext implements ItxAuth {
  readonly #directory: ProjectDirectory | undefined;
  readonly #isAdmin: boolean;
  readonly #principal: string;
  readonly #projectIds: Set<string>;
  readonly #userPrincipal: UserPrincipal | undefined;

  constructor(input: {
    directory?: ProjectDirectory;
    isAdmin: boolean;
    principal: string;
    projectIds?: Iterable<string>;
    userPrincipal?: UserPrincipal;
  }) {
    this.#directory = input.directory;
    this.#isAdmin = input.isAdmin;
    this.#principal = input.principal;
    this.#projectIds = new Set(input.projectIds ?? []);
    this.#userPrincipal = input.userPrincipal;
  }

  get principal(): string {
    return this.#principal;
  }

  /** The signed-in user behind this context, when the credential carried one. */
  get userPrincipal(): UserPrincipal | undefined {
    return this.#userPrincipal;
  }

  isAdmin(): boolean {
    return this.#isAdmin;
  }

  canAccessProject(projectId: string): boolean {
    return this.#isAdmin || this.#projectIds.has(projectId);
  }

  assertCanAccessProject(projectId: string | null): void {
    if (projectId === null) {
      if (!this.isAdmin()) {
        throw new Error(`principal "${this.#principal}" cannot access the platform project`);
      }
      return;
    }
    if (!this.canAccessProject(projectId)) {
      throw new Error(`principal "${this.#principal}" has no access to project "${projectId}"`);
    }
  }

  listAccessibleProjects(): string[] {
    return this.#isAdmin ? [] : [...this.#projectIds];
  }

  /**
   * Async access check with directory fallback. Claims are the fast path; on a
   * miss the auth worker's project directory is the source of truth (fixes the
   * stale-claims window right after project creation). A hit widens this live
   * context so subsequent synchronous asserts pass.
   */
  async ensureCanAccessProject(projectId: string): Promise<void> {
    if (this.canAccessProject(projectId)) return;
    if (this.#userPrincipal && this.#directory) {
      if (await this.#directory.userHasProject(this.#userPrincipal, projectId)) {
        this.widenProjectAccess(projectId);
        return;
      }
    }
    this.assertCanAccessProject(projectId);
  }

  /** Grant this live context access to a project it just created. */
  widenProjectAccess(projectId: string): void {
    this.#projectIds.add(projectId);
  }
}

export function trustedInternalAuthContext(): ItxAuthContext {
  return new ItxAuthContext({ isAdmin: true, principal: "trusted-internal" });
}

export function userPrincipalOf(auth: ItxAuth): UserPrincipal | undefined {
  return auth instanceof ItxAuthContext ? auth.userPrincipal : undefined;
}

export async function resolveItxAuth(input: {
  config: AppConfig;
  credentials: ItxAuthCredentials;
  headers: Headers;
  requestUrl: string;
}): Promise<ItxAuthContext> {
  const { config, credentials } = input;

  if (credentials.type === "admin-secret") {
    assertAdminSecret(config, credentials.secret);
    return new ItxAuthContext({ isAdmin: true, principal: "admin" });
  }

  if (credentials.type === "impersonate") {
    assertAdminSecret(config, credentials.secret);
    return contextFromImpersonatedToken(credentials.token);
  }

  if (credentials.type === "bearer") {
    const auth = createOsIterateAuth(config, input.requestUrl);
    if (!auth) throw new Error("iterate auth is not configured");
    const accessToken = await auth.authenticateBearer({
      headers: new Headers({ authorization: `Bearer ${credentials.token}` }),
    });
    if (!accessToken) throw new Error("missing or invalid auth");
    return contextFromPrincipal(config, principalFromAccessToken(accessToken));
  }

  // from-server-cookie: the admin cookie wins (browser REPL admin + Playwright
  // bridge), else the iterate_session cookie.
  const adminPrincipal = authenticateCapnwebAdmin({
    config,
    request: new Request(input.requestUrl, { headers: input.headers }),
  });
  if (adminPrincipal) return new ItxAuthContext({ isAdmin: true, principal: "admin" });

  const auth = createOsIterateAuth(config, input.requestUrl);
  if (!auth) throw new Error("iterate auth is not configured");
  const result = await auth.authenticate({ headers: input.headers, includeUserInfo: false });
  if (!result.session) throw new Error("missing or invalid auth");
  return contextFromPrincipal(config, principalFromSession(result.session));
}

function assertAdminSecret(config: AppConfig, secret: string): void {
  const admin = authenticateAdminBearer({
    authorizationHeader: `Bearer ${secret}`,
    config,
  });
  if (!admin) throw new Error("missing or invalid auth");
}

function contextFromPrincipal(config: AppConfig, principal: Principal): ItxAuthContext {
  if (principal.type === "admin") {
    return new ItxAuthContext({ isAdmin: true, principal: "admin" });
  }
  return new ItxAuthContext({
    directory: authWorkerProjectDirectory(config),
    isAdmin: principalIsAdmin(principal),
    principal: principal.userId,
    projectIds: principal.projects.map((project) => project.id),
    userPrincipal: principal,
  });
}

function contextFromImpersonatedToken(token: ItxAuthToken): ItxAuthContext {
  if (token.type === "admin") {
    return new ItxAuthContext({ isAdmin: true, principal: token.principal ?? "admin" });
  }
  return new ItxAuthContext({
    isAdmin: false,
    principal: token.principal,
    projectIds: token.projectScopes,
  });
}

// Directory lookups are rare (only the stale-claims window) but can be hit in
// bursts right after a create; a short-lived positive/negative cache keeps the
// auth worker out of the hot path.
const DIRECTORY_CACHE_TTL_MS = 30_000;
const directoryCache = new Map<string, { expiresAt: number; hasProject: boolean }>();

function authWorkerProjectDirectory(config: AppConfig): ProjectDirectory | undefined {
  if (!config.iterateAuth?.serviceToken) return undefined;
  return {
    async userHasProject(userPrincipal, projectId) {
      const cacheKey = `${userPrincipal.userId}:${projectId}`;
      const cached = directoryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.hasProject;

      let hasProject = false;
      for (const organization of userPrincipal.organizations) {
        const client = createAuthWorkerServiceClient(
          { config },
          { asUserId: userPrincipal.userId },
        );
        const projects = await client.project
          .list({ organizationSlug: organization.slug })
          .catch(() => []);
        if (projects.some((project) => project.id === projectId)) {
          hasProject = true;
          break;
        }
      }
      directoryCache.set(cacheKey, {
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
        hasProject,
      });
      return hasProject;
    },
  };
}
