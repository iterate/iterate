// auth.ts — the access boundary, and the ONLY authority decision in the system.
//
// The whole model is one line: you are either an admin (may reach any project)
// OR you hold a list of project ids and may reach exactly those. There is no
// product-capability gating anywhere downstream — once the connect door lets
// you into a project context, everything inside it is confined BY CONSTRUCTION:
// host capabilities name only that project, agents reach their project through
// an explicit host-owned member, and public durable addresses are only dynamic
// worker/facet descriptions. So authority lives in the ItxAuthContext every
// authenticated RPC target carries. The one non-product exception is a private
// brand on auth contexts minted while a source stream calls a receiver: it makes
// receiver-only methods unreachable from project code without changing project
// authorization or trusting a caller-controlled principal string.
//
// Credential lanes (see resolveItxAuth):
//   from-server-cookie — the browser lane: a short-lived, signed operator
//     cookie, else the `iterate_session` cookie verified against the auth
//     worker's JWKS. Ambient cookies require an exact same-origin request.
//   bearer            — an auth-worker access token presented as RPC data.
//   admin-secret      — APP_CONFIG_ADMIN_API_SECRET; the CLI/e2e/tooling lane.
//   operator-session  — a short-lived deployment- and origin-bound operator
//     grant. Project grants reconstruct a synthetic principal with exactly one
//     project; they never impersonate a customer or widen from the directory.
//   impersonate       — admin-secret-gated fake principal (tests): lets suites
//     exercise user-vs-user confinement against any deployment without minting
//     real users.
//
// Stale-claims: a session's project claims lag reality right after a project
// is created. `ensureCanAccessProject` treats claims as the fast path and the
// auth worker's directory as the source of truth — one cached membership
// lookup widens the live context instead of forcing a token refresh.

import { identityFromAccessToken, identityFromSession } from "@iterate-com/auth/server";
import { authenticateAdminBearer } from "./auth/admin.ts";
import {
  authenticateOperatorSession,
  authenticateOperatorToken,
  isSameOriginBrowserRequest,
} from "./auth/operator-session.ts";
import { createOsIterateAuth } from "./auth/iterate-auth-client.ts";
import { itxEnv } from "./env.ts";
import {
  principalFromIdentity,
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
 *   Project grants create a synthetic operator principal authorized for one
 *   resolved project only; they do not impersonate a customer. Platform-wide
 *   grants are a separate, explicit kind.
 * - `impersonate` — admin-secret-gated fake principal, for test suites that
 *   exercise per-project confinement without minting real users.
 */
export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token: string }
  | { type: "admin-secret"; secret: string }
  | { type: "operator-session"; token: string }
  | { type: "impersonate"; secret: string; token: ItxAuthToken }
  /**
   * A project's own long-lived machine credential — for externally deployed
   * apps that connect back to /api as their project (docs/remote-apps.md).
   * Verified against the secret every project is born with at
   * `/secrets/project-api-key` (the comparison happens inside the Secret
   * Durable Object — this door never receives material, only a one-bit
   * answer). None of the existing lanes fit this caller: `bearer` is a
   * user identity, `operator-session` is a short-lived human grant, and
   * `admin-secret` is deployment-global. Grants exactly one project, no
   * admin, no user identity.
   */
  | { type: "project-secret"; projectId: string; secret: string }
  /**
   * The short-lived user-on-project token auth mints for project app hosts
   * (the `iterate-project-auth` cookie). A config worker reverse-proxying an
   * externally deployed app forwards the browser's request as-is, and the app
   * presents the token here to act AS THAT USER on exactly that project
   * (docs/remote-apps.md). Verified locally — an HS256 check against the
   * shared project-app-session secret, no auth-worker hop; membership was
   * checked at mint time and the 15-minute expiry bounds revocation lag.
   */
  | { type: "project-app-session"; token: string };

/** A request supplied no usable authority. This is a caller outcome at the
 * public authentication door, not a server defect. */
export class ItxAuthenticationError extends Error {
  constructor() {
    super("missing or invalid auth");
    this.name = "ItxAuthenticationError";
  }
}

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

const streamDeliveryAuthContexts = new WeakSet<ItxAuthContext>();

/** Authority minted only while one source stream resolves and calls a receiver.
 * Project streams can reach exactly their own project; only a deployment-global
 * stream receives deployment-global authority. The private brand grants access
 * to receiver-only methods without widening the ordinary project boundary. */
export function streamDeliveryAuthContext(projectId: string | null): ItxAuthContext {
  const auth = new ItxAuthContext({
    isAdmin: projectId === null,
    principal: "trusted-internal",
    ...(projectId === null ? {} : { projectIds: [projectId] }),
  });
  streamDeliveryAuthContexts.add(auth);
  return auth;
}

/** This identity brand cannot be reproduced through any public credential lane. */
export function isStreamDeliveryAuth(auth: ItxAuth): boolean {
  return auth instanceof ItxAuthContext && streamDeliveryAuthContexts.has(auth);
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

/** Exchange explicit Cap'n Web credentials for capability authority, or reject. */
export async function resolveItxAuth(input: {
  config: AppConfig;
  credentials: ItxAuthCredentials;
  headers: Headers;
  requestUrl: string;
  /** The `project-secret` lane's verifier — dials the project's born
   * `/secrets/project-api-key` Secret Durable Object for a one-bit
   * constant-time comparison (rpc-targets wires it; auth stays free of DO
   * plumbing). Absent means the caller does not serve that lane. */
  verifyProjectSecret?: (input: { projectId: string; secret: string }) => Promise<boolean>;
  /** The `project-app-session` lane's verifier — a local HS256 signature +
   * expiry check against the shared session secret (rpc-targets wires it).
   * Answers the token's own claims or null; absent means the caller does not
   * serve that lane. */
  verifyProjectAppSession?: (
    token: string,
  ) => Promise<{ projectId: string; userId: string } | null>;
}): Promise<ItxAuthContext> {
  const { config, credentials } = input;

  if (credentials.type === "admin-secret") {
    assertAdminSecret(config, credentials.secret);
    return new ItxAuthContext({ isAdmin: true, principal: "admin" });
  }

  if (credentials.type === "project-secret") {
    if (input.verifyProjectSecret === undefined) throw new ItxAuthenticationError();
    if (credentials.secret.length === 0) throw new ItxAuthenticationError();
    const verified = await input.verifyProjectSecret({
      projectId: credentials.projectId,
      secret: credentials.secret,
    });
    if (!verified) throw new ItxAuthenticationError();
    // Exactly one project, no admin, no user identity — and no directory
    // fallback: the credential IS the project scope; there is nothing to
    // widen into.
    return new ItxAuthContext({
      isAdmin: false,
      principal: `project-secret:${credentials.projectId}`,
      projectIds: [credentials.projectId],
    });
  }

  if (credentials.type === "project-app-session") {
    if (input.verifyProjectAppSession === undefined) throw new ItxAuthenticationError();
    if (credentials.token.length === 0) throw new ItxAuthenticationError();
    const claims = await input.verifyProjectAppSession(credentials.token);
    if (claims === null) throw new ItxAuthenticationError();
    // One user on one project, exactly as minted — no admin, no directory
    // fallback. The principal names the human so audit trails show who acted
    // through the proxied app.
    return new ItxAuthContext({
      isAdmin: false,
      principal: `project-app-session:${claims.userId}@${claims.projectId}`,
      projectIds: [claims.projectId],
    });
  }

  if (credentials.type === "operator-session") {
    const session = await authenticateOperatorToken({
      config,
      requestUrl: input.requestUrl,
      token: credentials.token,
    });
    if (!session) throw new ItxAuthenticationError();
    return itxAuthFromPrincipal(session.principal, { allowDirectoryFallback: false });
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
    if (!accessToken) throw new ItxAuthenticationError();
    return itxAuthFromPrincipal(principalFromIdentity(identityFromAccessToken(accessToken)));
  }

  // Ambient cookies are authority only on an exact-origin browser request.
  const cookieRequest = new Request(input.requestUrl, { headers: input.headers });
  if (!isSameOriginBrowserRequest(cookieRequest)) throw new ItxAuthenticationError();

  const operatorSession = await authenticateOperatorSession({ config, request: cookieRequest });
  if (operatorSession) {
    return itxAuthFromPrincipal(operatorSession.principal, { allowDirectoryFallback: false });
  }

  const auth = createOsIterateAuth(config, input.requestUrl);
  if (!auth) throw new Error("iterate auth is not configured");
  // An in-band RPC call cannot carry a rotated Set-Cookie back to the browser.
  const { session } = await auth.authenticateSession({
    headers: input.headers,
    refresh: "never",
  });
  if (!session) throw new ItxAuthenticationError();
  return itxAuthFromPrincipal(principalFromIdentity(identityFromSession(session)));
}

function assertAdminSecret(config: AppConfig, secret: string): void {
  const admin = authenticateAdminBearer({
    authorizationHeader: `Bearer ${secret}`,
    config,
  });
  if (!admin) throw new ItxAuthenticationError();
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
  principal: Principal,
  options: { allowDirectoryFallback?: boolean } = {},
): ItxAuthContext {
  if (principal.type === "admin") {
    return new ItxAuthContext({ isAdmin: true, principal: "admin" });
  }
  return new ItxAuthContext({
    directory: options.allowDirectoryFallback === false ? undefined : authWorkerProjectDirectory(),
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

function authWorkerProjectDirectory(): ProjectDirectory {
  return {
    async userHasProject(userPrincipal, projectId) {
      const cacheKey = `${userPrincipal.userId}:${projectId}`;
      const cached = directoryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.hasProject;

      // An RPC failure is a dependency outage, not a negative authorization
      // decision. Let it propagate so callers can retry and no denial is
      // cached under a false identity claim.
      const projects = await itxEnv.AUTH.listProjectsForUser({ userId: userPrincipal.userId });
      const hasProject = projects.some((project) => project.id === projectId);
      directoryCache.set(cacheKey, {
        expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
        hasProject,
      });
      return hasProject;
    },
  };
}
