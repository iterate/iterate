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
//   from-server-cookie — the browser lane: a short-lived, signed operator
//     cookie, else the `iterate_session` cookie verified against the auth
//     worker's JWKS. Ambient cookies require an exact same-origin request.
//   bearer            — an auth-worker access token presented as RPC data.
//   admin-secret      — APP_CONFIG_ADMIN_API_SECRET; the CLI/e2e/tooling lane.
//   operator-session  — a short-lived deployment- and origin-bound grant.
//   impersonate       — admin-secret-gated fake principal (tests): lets suites
//     exercise user-vs-user confinement against any deployment without minting
//     real users.
//
// Stale-claims: a session's project claims lag reality right after a project
// is created. `ensureCanAccessProject` treats claims as the fast path and the
// auth worker's directory as the source of truth — one cached membership
// lookup widens the live context instead of forcing a token refresh.

import { authenticateAdminBearer } from "./auth/admin.ts";
import {
  authenticateOperatorSession,
  authenticateOperatorToken,
  isSameOriginBrowserRequest,
} from "./auth/operator-session.ts";
import { createAuthWorkerServiceClient } from "./auth/auth-worker-service.ts";
import { createOsIterateAuth } from "./auth/iterate-auth-client.ts";
import {
  principalFromAccessToken,
  principalFromSession,
  principalIsAdmin,
  type Principal,
  type UserPrincipal,
} from "./auth/principal.ts";
import type { AppConfig } from "./config.ts";

/**
 * Credentials accepted by `UnauthenticatedOs.authenticate`.
 *
 * - `from-server-cookie` — the browser lane: an operator/session cookie on an
 *   exact same-origin HTTP request or WebSocket handshake.
 * - `bearer` — an auth access token presented as RPC data.
 * - `admin-secret` — the deployment admin API secret (CLI / tooling / e2e).
 * - `operator-session` — a short-lived grant minted with the admin secret.
 * - `impersonate` — admin-secret-gated fake principal, for test suites that
 *   exercise per-project confinement without minting real users.
 */
export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token: string }
  | { type: "admin-secret"; secret: string }
  | { type: "operator-session"; token: string }
  | { type: "impersonate"; secret: string; token: ItxAuthToken };

/** Principal shape for `impersonate` credentials. */
export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

/** Authority object carried by server-side RPC target instances. */
export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
  /**
   * Async access check that may consult the project directory (source of
   * truth) when synchronous claims miss — see the auth adapter. Optional so
   * in-process trusted contexts stay trivially constructible.
   */
  ensureCanAccessProject?(projectId: string): Promise<void>;
}

type ProjectDirectory = {
  userHasProject(userPrincipal: UserPrincipal, projectId: string): Promise<boolean>;
};

class ItxAuthContext implements ItxAuth {
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

/** Grant a live auth context access to a project it just created. */
export function widenProjectAccess(auth: ItxAuth, projectId: string): void {
  if (auth instanceof ItxAuthContext) auth.widenProjectAccess(projectId);
}

/**
 * Pick the organization that should own a new project: an explicitly requested
 * org the user belongs to, else their sole membership. Ported from the legacy
 * project directory — the auth worker's org grant is what makes the project
 * appear in the user's claims.
 */
export function resolveOrganizationSlugForCreate(
  userPrincipal: UserPrincipal,
  requestedSlug: string | undefined,
): string {
  const organizations = userPrincipal.organizations;
  if (requestedSlug) {
    const organization = organizations.find((candidate) => candidate.slug === requestedSlug);
    if (!organization) {
      throw new Error(`Organization ${requestedSlug} is not available to this user.`);
    }
    return organization.slug;
  }
  if (organizations.length === 1) return organizations[0]!.slug;
  throw new Error(
    organizations.length === 0
      ? "Project creation requires organization membership."
      : "Pass organizationSlug to choose which organization should own the project.",
  );
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

  if (credentials.type === "operator-session") {
    const session = await authenticateOperatorToken({
      config,
      requestUrl: input.requestUrl,
      token: credentials.token,
    });
    if (!session) throw new Error("missing or invalid auth");
    return itxAuthFromPrincipal(config, session.principal, { allowDirectoryFallback: false });
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
    return itxAuthFromPrincipal(config, principalFromAccessToken(accessToken));
  }

  // Ambient cookies are never authority on a cross-origin browser socket.
  // Browsers always send Origin on WebSocket handshakes; non-browser clients
  // normally omit it and authenticate explicitly.
  const cookieRequest = new Request(input.requestUrl, { headers: input.headers });
  if (!isSameOriginBrowserRequest(cookieRequest)) throw new Error("missing or invalid auth");

  // A short-lived operator session wins over the ordinary Iterate session so
  // an operator can open a narrowly-scoped browser without signing out first.
  const operatorSession = await authenticateOperatorSession({
    config,
    request: cookieRequest,
  });
  if (operatorSession) {
    return itxAuthFromPrincipal(config, operatorSession.principal, {
      allowDirectoryFallback: false,
    });
  }

  const auth = createOsIterateAuth(config, input.requestUrl);
  if (!auth) throw new Error("iterate auth is not configured");
  const result = await auth.authenticate({ headers: input.headers, includeUserInfo: false });
  if (!result.session) throw new Error("missing or invalid auth");
  return itxAuthFromPrincipal(config, principalFromSession(result.session));
}

function assertAdminSecret(config: AppConfig, secret: string): void {
  const admin = authenticateAdminBearer({
    authorizationHeader: `Bearer ${secret}`,
    config,
  });
  if (!admin) throw new Error("missing or invalid auth");
}

/**
 * The itx auth context for an already-authenticated principal — the in-process
 * lane. Server-side code that already holds the request middleware's principal
 * (server functions, server routes) builds its session objects through this
 * instead of re-presenting credentials to the `/api` door. Ordinary sessions
 * may refresh stale membership through the directory; scoped operator grants
 * explicitly disable that widening path.
 */
export function itxAuthFromPrincipal(
  config: AppConfig,
  principal: Principal,
  options: { allowDirectoryFallback?: boolean } = {},
): ItxAuthContext {
  if (principal.type === "admin") {
    return new ItxAuthContext({ isAdmin: true, principal: "admin" });
  }
  return new ItxAuthContext({
    directory:
      options.allowDirectoryFallback === false ? undefined : authWorkerProjectDirectory(config),
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
      let lookupFailed = false;
      for (const organization of userPrincipal.organizations) {
        const client = createAuthWorkerServiceClient(
          { config },
          { asUserId: userPrincipal.userId },
        );
        let projects;
        try {
          projects = await client.project.list({ organizationSlug: organization.slug });
        } catch {
          // Auth worker unreachable is NOT "no membership": deny THIS check
          // without caching the denial, so the next request retries instead
          // of locking the user out for the cache window.
          lookupFailed = true;
          continue;
        }
        if (projects.some((project) => project.id === projectId)) {
          hasProject = true;
          break;
        }
      }
      if (!hasProject && lookupFailed) return false;
      directoryCache.set(cacheKey, {
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
        hasProject,
      });
      return hasProject;
    },
  };
}
