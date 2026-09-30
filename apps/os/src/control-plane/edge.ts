// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the deployment's D1 (catalog.ts, one statement or one batch).
// WHAT AN ISOLATE KEEPS (`Kept`): a catalog answer five seconds — a project's row (its primary
// hostname with it), a host's address, a person's access — and a project miss never. A refusal is
// read again at once (a project not in a kept access set is re-read before it is refused), since
// nothing routes two requests to one isolate
// (https://developers.cloudflare.com/workers/reference/how-workers-works/): a creation is reachable
// at once, and the isolate that made a change keeps its result at once. Kept are answers, never a
// read in flight: a request awaiting another's read hangs when that request ends first, its I/O
// cancelled with it (https://developers.cloudflare.com/workers/observability/errors/).
// A call that fails on the platform's side throws UNAVAILABLE (unavailable.ts), which a project host
// answers 503 (worker.ts).
import { customHostnameCandidatesOf, type ProjectAddress } from "iterate/project-ingress";
import { SqlfuError } from "sqlfu";
import { errorCode, withTimeout } from "iterate/lib";
import {
  failureKind,
  isOpaqueInternalError,
  isPlatformFailureKind,
  logPlatformFailure,
} from "iterate/platform-retry";
import type { Caller } from "../caller.ts";
import { projectHostOf, type AppConfig } from "../app-config.ts";
import type { Env } from "../env.ts";
import { Kept } from "../kept.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import { unavailableError } from "../unavailable.ts";
import {
  type AccessibleRecord,
  ControlPlaneDatabase,
  type IntegrationRouteRecord,
  type OrganizationRecord,
  type ProjectRecord,
  type ProjectRow,
  type UserRecord,
} from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";
import { OAuthGrantTable } from "./oauth-grants.ts";

/** Membership-derived access, optionally capped to selected projects. The administrator alone
 *  reaches every project; explicit empty selections reach none. */
export type Reach = "every" | { userId: string; projectIds?: string[] } | { projectIds: string[] };

/** `reach`, for a refusal's message (session.ts `projects.get`). */
export const describeReach = (reach: Reach): string =>
  reach === "every"
    ? "every project"
    : "userId" in reach
      ? `the projects of the orgs ${reach.userId} belongs to`
      : `bound to ${reach.projectIds.map((projectId) => JSON.stringify(projectId)).join(", ") || "no project"}`;

/** How long an isolate keeps a catalog answer, and so how long a change made through another
 *  isolate (a deletion, a removed member, a moved hostname) can go unseen here. Keeping nothing
 *  would put a round trip to D1's primary (WEUR) before every project host's context is dialled:
 *  9–30 ms from Europe, 80–310 ms from the US, Asia and Oceania (measured 2026-09-27). */
const KEPT_MS = 5_000;

/** Projects' rows, each under its id and its slug (`keep`), their primary hostnames with them. */
const projects = new Kept<ProjectRow>(KEPT_MS);
const keep = (project: ProjectRow) => {
  for (const ref of [project.id, project.slug]) projects.set(ref, project);
};
/** Hosts' addresses under projects' own hostnames, hit or miss. A kept miss seldom hides a new
 *  claim: the processor claims a hostname before it asks Cloudflare to route it (project/processor.ts
 *  `#addHostname`), so visitors reach it once it is claimed — unless Cloudflare still routes it from
 *  before (an erase leaves custom hostnames in place), and then for `KEPT_MS` at most. A removed
 *  hostname stops routing within `KEPT_MS`, and Cloudflare stops sending it sooner (`#removeHostname`
 *  deletes the custom hostname first). */
const hosts = new Kept<{ address: ProjectAddress | null }>(KEPT_MS);
/** People's access, by user id: dropped at once here for the person a command was made by or for. */
const access = new Kept<AccessibleRecord>(KEPT_MS);

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const callerOf = (caller: Caller) => ({ principal: caller.principal, grant: caller.grant });

/** The control plane as the edge holds it — ONE per request (worker.ts), or per socket (rpc.ts),
 *  over the `DB` binding.
 *
 *  `readDeadlineMs`: how long this holder waits for a read before it throws UNAVAILABLE
 *  (overloaded). `/api` sets one (rpc.ts): its caller is a client that can ask again, where a read
 *  that hangs would hold the call until D1's own 30 s bound. A project host sets none: a slow
 *  answer is still the answer. */
export class ControlPlane {
  readonly #db: ControlPlaneDatabase;
  readonly #grants: OAuthGrantTable;
  readonly #readDeadlineMs: number | undefined;
  constructor(env: Pick<Env, "DB">, { readDeadlineMs }: { readDeadlineMs?: number } = {}) {
    this.#db = new ControlPlaneDatabase(env.DB);
    this.#grants = new OAuthGrantTable(env.DB);
    this.#readDeadlineMs = readDeadlineMs;
  }

  /** ONE read: failed on the platform's side, or unanswered at this holder's `readDeadlineMs`, it
   *  throws UNAVAILABLE. */
  #read<T>(method: string, read: () => Promise<T>): Promise<T> {
    return this.#withinDeadline(method, this.#call(method, read));
  }

  /** `read`, or UNAVAILABLE (overloaded: capnp's word for "the operation timed out") once this
   *  holder's `readDeadlineMs` has passed without its answer, logged as
   *  `control-plane.platform-failure-read-deadline` (scripts/ci/prd-fault-alarm.ts pages on a
   *  burst). The read itself runs on, and a table it feeds (`accessibleTo`) still keeps its answer. */
  async #withinDeadline<T>(method: string, read: Promise<T>): Promise<T> {
    const deadlineMs = this.#readDeadlineMs;
    if (!deadlineMs) return read;
    try {
      return await withTimeout(read, deadlineMs, `the control plane's ${method}`);
    } catch (error) {
      if (errorCode(error) !== "TIMEOUT") throw error;
      console.warn({
        event: "control-plane.platform-failure-read-deadline",
        method,
        waitedMs: deadlineMs,
      });
      throw unavailableError(
        "overloaded",
        `The control plane failed ${method}: no answer within ${deadlineMs} ms`,
      );
    }
  }

  /** ONE call on the database, with no deadline. A failure of the platform's own (`failureKind`: a
   *  deploy's reset of D1, a lost connection, an overload) becomes UNAVAILABLE, logged once here as
   *  `control-plane.platform-failure-d1` (scripts/ci/prd-fault-alarm.ts pages on a burst), or at
   *  info as `control-plane.deploy-reset-d1`; whether to ask again is the caller's, who knows
   *  whether the call is idempotent (oauth-store.ts asks a grant call again once). workerd's opaque
   *  internal error (`isOpaqueInternalError`) is an overload here: D1 runs no code of ours or a
   *  project's, so it is the runtime's own failure, and in a Cloudflare outage every call meets it
   *  for minutes, so it is never repeated at once and a project host answers it 503. Any other sqlfu
   *  error is thrown again with its message only: its enumerable `query` holds the SQL and its bound
   *  values, which the /api error channel would hand the client (iterate/lib's errors), and a cause
   *  passed to `Error` is not enumerable. */
  async #call<T>(method: string, call: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await call();
    } catch (error) {
      const kind = isOpaqueInternalError(error) ? "overloaded" : failureKind(error);
      if (isPlatformFailureKind(kind) && error instanceof Error) {
        const unavailable = unavailableError(
          kind,
          `The control plane failed ${method}: ${error.message}`,
        );
        logPlatformFailure("control-plane", "d1", kind, {
          name: method,
          waitedMs: Date.now() - started,
          message: unavailable.message,
        });
        throw unavailable;
      }
      if (error instanceof SqlfuError)
        throw new Error(`The control plane failed ${method}: ${error.message}`, { cause: error });
      throw error;
    }
  }

  /** A project by id or by slug — THE lookup: a URL's `/projects/<slug>`, a hostname's label, an
   *  API call's `project`, a grant's id all resolve here. A row is kept `KEPT_MS`, a miss never: a
   *  scanner's label no project holds is one D1 read per request, and a project created anywhere is
   *  served at once. The row carries the project's primary hostname (catalog.ts `ProjectRow`), which
   *  the edge's redirect (worker.ts) and `itx.url` read: a change reaches them within `KEPT_MS`.
   *  `fresh` reads past what this isolate keeps (the orphan sweep, session.ts). */
  async getProject(ref: string, fresh = false): Promise<ProjectRow | null> {
    const kept = !fresh && projects.get(ref);
    if (kept) return kept;
    const project = await this.#read("project", () => this.#db.project(ref));
    if (project) keep(project);
    return project;
  }

  /** Whether `projectId` names a deleted project (catalog.ts `deletedProject`): asked at a root
   *  context's birth and before the deletion saga destroys it, so never kept. */
  deletedProject(projectId: string): Promise<boolean> {
    return this.#read("deletedProject", () => this.#db.deletedProject(projectId));
  }

  /** The project `url` is a host of — THE INGRESS ROUTING TABLE: the static rules first (app-config.ts
   *  `projectHostOf`: the ingress routing and the project wildcard), then a hostname a project added
   *  itself (project/custom-hostnames.ts): its apex, or one label under it a routing slug
   *  (iterate/project-ingress `customHostnameCandidatesOf`), in ONE catalog read, kept `KEPT_MS`,
   *  hit or miss. A deployment that serves no custom hostnames, the platform's
   *  own origins and anything under its reserved zones never reach the table. A project host's
   *  admission (worker.ts) and consent.ts, which binds a project's CIMD client to it, read it. */
  async projectHostOf(
    config: AppConfig,
    url: URL,
    platformOrigin: string,
  ): Promise<ProjectAddress | null> {
    const address = projectHostOf(config, url, platformOrigin);
    if (address) return address;
    if (!config.customHostnames) return null;
    if (url.origin === platformOrigin || url.origin === config.urls.mcp) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      config.customHostnames.reservedZones.some(
        (zone) => hostname === zone || hostname.endsWith(`.${zone}`),
      )
    )
      return null;
    const kept = hosts.get(hostname);
    if (kept) return kept.address;
    const candidates = customHostnameCandidatesOf(hostname);
    const found = await this.#read("projectByHostname", () =>
      this.#db.projectByHostname(candidates.map((candidate) => candidate.hostname)),
    );
    // the row came with it: the admission's next read (getProject) finds it kept
    if (found) keep(found.project);
    const custom = found && {
      routingSlug: candidates.find((candidate) => candidate.hostname === found.hostname)!
        .routingSlug,
      project: found.project.id,
      basePath: "",
    };
    hosts.set(hostname, { address: custom });
    return custom;
  }

  /** The connection a provider account's webhooks go to (catalog.ts `routeIntegration`). Never
   *  kept: a route released and taken by another project routes there on the next delivery. */
  integrationRouteOf(provider: string, externalId: string): Promise<IntegrationRouteRecord | null> {
    return this.#read("integrationRoute", () => this.#db.integrationRoute(provider, externalId));
  }

  /** The id a ref names: an id is self-evident (`prj_…` — a slug never holds an underscore), a
   *  slug resolves through the catalog, and a slug nobody holds names nothing (null) — for every
   *  reach, the operator's included: passed through as an id, it once minted contexts named by
   *  the slug (prd, 2026-09-25: `templestein.iterate/` while the D1 catalog was being filled, and
   *  `lupa-s-organization.iterate/repos/config` after that project's deletion). */
  async projectIdOf(ref: string): Promise<string | null> {
    if (ref.startsWith("prj_")) return ref;
    return (await this.getProject(ref))?.id ?? null;
  }

  /** What a person can access — kept `KEPT_MS`; `fresh` reads past it (the re-read before a
   *  refusal). */
  async accessibleTo(userId: string, fresh = false): Promise<AccessibleRecord> {
    const kept = !fresh && access.get(userId);
    if (kept) return kept;
    const read = this.#call("accessibleTo", () => this.#db.accessibleTo(userId));
    return this.#withinDeadline(
      "accessibleTo",
      read.then((record) => {
        access.set(userId, record);
        return record;
      }),
    );
  }

  /** Whether `reach` reaches `ref` — the admission behind `projects.get` (session.ts), a `/mcp`
   *  tool's `project` and a project host's visitor (worker.ts). The admin reaches a project the
   *  catalog never heard of by its `prj_…` id, never by a slug nobody holds; a named reach is its list; a user's is their memberships — re-read
   *  once before a refusal. */
  async reachesProject(reach: Reach, ref: string): Promise<boolean> {
    const id = await this.projectIdOf(ref);
    if (!id) return false;
    if (reach === "every") return true;
    if (reach.projectIds && !reach.projectIds.includes(id)) return false;
    if (!("userId" in reach)) return true;
    const reaches = (record: AccessibleRecord) =>
      record.projects.some((project) => project.id === id);
    return (
      reaches(await this.accessibleTo(reach.userId)) ||
      reaches(await this.accessibleTo(reach.userId, true))
    );
  }

  /** The id of the project `ref` (its id or its slug) names, when `reach` reaches it, else null:
   *  `reachesProject` for a caller that names a project by what a person types (`projects.get`,
   *  session.ts; a `/mcp` tool's `project`). A user's reach finds the project in their access
   *  record, which holds every slug they can reach, so a slug costs no catalog read; the record is
   *  re-read once before a refusal, as `reachesProject` does. The admin's and a named reach resolve
   *  `ref` through the catalog (`projectIdOf`). */
  async reachableProjectId(reach: Reach, ref: string): Promise<string | null> {
    if (reach === "every" || !("userId" in reach)) {
      const id = await this.projectIdOf(ref);
      return id && (await this.reachesProject(reach, id)) ? id : null;
    }
    const named = (record: AccessibleRecord) =>
      record.projects.find((project) => project.id === ref || project.slug === ref);
    const project =
      named(await this.accessibleTo(reach.userId)) ??
      named(await this.accessibleTo(reach.userId, true));
    if (!project || (reach.projectIds && !reach.projectIds.includes(project.id))) return null;
    return project.id;
  }

  /** The projects `reach` reaches: every one for the admin secret; the user's, with their role;
   *  the named ones (a name the catalog never heard of is no record). `expected` names the ids the
   *  caller refuses without (consent's ticked projects, a socket's held ones): one of them, or of
   *  the reach's own selection, missing from the kept access set is re-read once first — the
   *  project may have been created on another isolate within `KEPT_MS`. `fresh` reads past what is
   *  kept (a list a person reads again because something changed: session.ts). */
  async reachableProjects(
    reach: Reach,
    expected: readonly string[] = [],
    fresh = false,
  ): Promise<ProjectRecord[]> {
    if (reach === "every") return this.#read("projects", () => this.#db.projects());
    if ("userId" in reach) {
      const { userId, projectIds } = reach;
      const named = [...expected, ...(projectIds || [])];
      let record = await this.accessibleTo(userId, fresh);
      if (!fresh && !named.every((id) => record.projects.some((project) => project.id === id)))
        record = await this.accessibleTo(userId, true);
      return projectIds
        ? record.projects.filter((project) => projectIds.includes(project.id))
        : record.projects;
    }
    const rows = await Promise.all(reach.projectIds.map((projectId) => this.getProject(projectId)));
    // records, as every reach lists them (iterate/api `ProjectRecord`)
    return rows.flatMap((row) => (row ? [{ id: row.id, slug: row.slug, orgId: row.orgId }] : []));
  }

  /** Whether `reach` may hold `organizationId`'s context: the admin every one; a user the ones they
   *  belong to — re-read once before a refusal. */
  async reachesOrg(reach: Reach, organizationId: string): Promise<boolean> {
    if (reach === "every") return true;
    if (!("userId" in reach)) return false;
    const belongs = (record: AccessibleRecord) =>
      record.organizations.some((organization) => organization.id === organizationId);
    return (
      belongs(await this.accessibleTo(reach.userId)) ||
      belongs(await this.accessibleTo(reach.userId, true))
    );
  }

  /** Every organization, oldest first. */
  listOrganizations() {
    return this.#read("organizations", () => this.#db.organizations());
  }
  /** An organization's members, in the order they joined. */
  listMembers(organizationId: string) {
    return this.#read("members", () => this.#db.members(organizationId));
  }
  /** An organization's open invitation links — its owners', or the operator's (catalog.ts). */
  listInvitations(caller: Caller, organizationId: string) {
    return this.#read("openInvitations", () =>
      this.#db.openInvitations(callerOf(caller), organizationId),
    );
  }
  /** What an invitation link opens, for `userId` (null: nobody signed in) — by the token's hash. */
  getInvitation(tokenHash: string, userId: string | null) {
    return this.#read("invitation", () => this.#db.invitation(tokenHash, userId, Date.now()));
  }
  /** A user by id or by email. */
  getUser(ref: string) {
    return this.#read("user", () => this.#db.user(ref));
  }
  /** The user a provider's subject names. */
  identity(provider: IdentityProvider, subject: string) {
    return this.#read("identity", () => this.#db.identity(provider, subject));
  }
  listUsers() {
    return this.#read("users", () => this.#db.users());
  }

  // ── the commands: each one call, under the caller ──

  /** Find-or-create the person for an email. No caller: sign-in (`ensureUser`) and the operator's
   *  `session.users` (session.ts refuses everyone else) are its only callers. */
  createUser(input: { email: string }): Promise<UserRecord> {
    return this.#call("createUser", () => this.#db.createUser(input));
  }
  /** What sign-in calls (password-and-code-sign-in.ts, issuer-session.ts): the catalog first. */
  async ensureUser(email: string): Promise<UserRecord> {
    return (await this.getUser(email)) ?? this.createUser({ email });
  }
  /** A verified sign-in's identity (identity.ts): link once by email, then by subject. The
   *  system's own write — no caller. */
  linkIdentity(provider: IdentityProvider, subject: string, email: string): Promise<UserRecord> {
    return this.#call("linkIdentity", () => this.#db.linkIdentity({ provider, subject, email }));
  }
  /** A sign-in a signed-in person adds to their account (identity.ts's link mode). The system's
   *  own write — no caller. */
  addIdentity(userId: string, provider: IdentityProvider, subject: string): Promise<UserRecord> {
    return this.#call("addIdentity", () =>
      this.#db.addIdentity({ userId, provider, subject, now: Date.now() }),
    );
  }

  async createOrganization(
    caller: Caller,
    input: { name: string; ownerId?: string },
  ): Promise<OrganizationRecord> {
    const organization = await this.#call("createOrganization", () =>
      this.#db.createOrganization(callerOf(caller), input, Date.now()),
    );
    this.#forget(caller.principal?.actor);
    if (input.ownerId) access.clear(); // the operator's: named by id or email
    return organization;
  }
  async renameOrganization(
    caller: Caller,
    organizationId: string,
    name: string,
  ): Promise<OrganizationRecord> {
    const organization = await this.#call("renameOrganization", () =>
      this.#db.renameOrganization(callerOf(caller), organizationId, name),
    );
    access.clear(); // the name rides every member's access record, not just the caller's
    return organization;
  }
  async deleteOrganization(caller: Caller, organizationId: string): Promise<void> {
    await this.#call("deleteOrganization", () =>
      this.#db.deleteOrganization(callerOf(caller), organizationId),
    );
    access.clear(); // every member's access changed
  }
  /** Answers the id the membership holds (the caller may have named the person by email). */
  async addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<string> {
    const userId = await this.#call("addMember", () =>
      this.#db.addMember(callerOf(caller), organizationId, input, Date.now()),
    );
    this.#forget(userId);
    return userId;
  }
  /** Answers the id removed. */
  async removeMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string },
  ): Promise<string> {
    const userId = await this.#call("removeMember", () =>
      this.#db.removeMember(callerOf(caller), organizationId, input),
    );
    this.#forget(userId);
    return userId;
  }
  createInvitation(
    caller: Caller,
    organizationId: string,
    input: { tokenHash: string; role: OrganizationRole; emailHint?: string; expiresAt: number },
  ) {
    return this.#call("createInvitation", () =>
      this.#db.createInvitation(callerOf(caller), organizationId, input, Date.now()),
    );
  }
  revokeInvitation(caller: Caller, organizationId: string, invitationId: string) {
    return this.#call("revokeInvitation", () =>
      this.#db.revokeInvitation(callerOf(caller), organizationId, invitationId, Date.now()),
    );
  }
  /** The caller joins the organization the link opens; their access is re-read at once. */
  async acceptInvitation(caller: Caller, tokenHash: string) {
    const accepted = await this.#call("acceptInvitation", () =>
      this.#db.acceptInvitation(callerOf(caller), tokenHash, Date.now()),
    );
    this.#forget(accepted.userId);
    return accepted;
  }
  /** A project: the catalog claims the slug and mints the id; the caller (session.ts) then opens the
   *  project's own creation saga on its root. */
  async createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ): Promise<ProjectRow & { mintedOrganization?: string }> {
    const { mintedOrganization, ...project } = await this.#call("createProject", () =>
      this.#db.createProject(callerOf(caller), input, Date.now()),
    );
    keep(project);
    this.#forget(caller.principal?.actor);
    return mintedOrganization ? { ...project, mintedOrganization } : project;
  }

  /** The project `caller` may delete (catalog.ts `projectToDelete`), or a refusal. */
  projectToDelete(caller: Caller, ref: string): Promise<ProjectRecord> {
    return this.#call("projectToDelete", () => this.#db.projectToDelete(callerOf(caller), ref));
  }
  /** A project's row goes (catalog.ts `deleteProject`): dropped here at once, and on every other
   *  isolate within `KEPT_MS`. */
  async deleteProject(caller: Caller, ref: string): Promise<ProjectRecord> {
    const project = await this.#call("deleteProject", () =>
      this.#db.deleteProject(callerOf(caller), ref),
    );
    projects.delete(project.id);
    projects.delete(project.slug);
    access.clear(); // every member's reach just changed
    return project;
  }

  // ── a project's own hostnames, which project/processor.ts claims and releases ──

  claimHostname(projectId: string, hostname: string): Promise<void> {
    return this.#call("claimHostname", () => this.#db.claimHostname(projectId, hostname));
  }
  hostnameHolder(hostname: string): Promise<string | null> {
    return this.#call("hostnameHolder", () => this.#db.hostnameHolder(hostname));
  }
  /** Another project's claim, or none, is left alone. */
  releaseHostname(projectId: string, hostname: string): Promise<void> {
    return this.#call("releaseHostname", () => this.#db.releaseHostname(projectId, hostname));
  }
  /** Route a provider account's webhooks to one connection (catalog.ts `routeIntegration`): first
   *  owner wins, a connection holds one account. */
  routeIntegration(
    provider: string,
    externalId: string,
    projectId: string,
    path: string,
  ): Promise<void> {
    return this.#call("routeIntegration", () =>
      this.#db.routeIntegration(provider, externalId, projectId, path),
    );
  }
  /** Move a provider account's route from the connection holding it to another, atomically
   *  (catalog.ts `moveIntegrationRoute`). */
  moveIntegrationRoute(
    provider: string,
    externalId: string,
    from: { projectId: string; path: string },
    to: { projectId: string; path: string },
  ): Promise<void> {
    return this.#call("moveIntegrationRoute", () =>
      this.#db.moveIntegrationRoute(provider, externalId, from, to),
    );
  }
  /** A failed move's undo, answering whether the route went back (catalog.ts
   *  `restoreIntegrationRoute`). */
  restoreIntegrationRoute(
    provider: string,
    externalId: string,
    from: { projectId: string; path: string },
    to: { projectId: string; path: string },
  ): Promise<boolean> {
    return this.#call("restoreIntegrationRoute", () =>
      this.#db.restoreIntegrationRoute(provider, externalId, from, to),
    );
  }
  /** Release one account's route, only while the connection at `path` holds it, answering whether
   *  it did (catalog.ts `releaseIntegrationRoute`). */
  releaseIntegrationRoute(
    provider: string,
    externalId: string,
    projectId: string,
    path: string,
  ): Promise<boolean> {
    return this.#call("releaseIntegrationRoute", () =>
      this.#db.releaseIntegrationRoute(provider, externalId, projectId, path),
    );
  }
  /** Release every route of the connection at `path`; another connection's are left alone. */
  releaseIntegrationRoutes(projectId: string, path: string): Promise<void> {
    return this.#call("releaseIntegrationRoutes", () =>
      this.#db.releaseIntegrationRoutes(projectId, path),
    );
  }
  /** Set a project's primary hostname (project/processor.ts publishes it), or clear it with null:
   *  the project's kept row, which carries it, is dropped here at once and read again on every
   *  other isolate within `KEPT_MS`. */
  async setPrimaryHostname(projectId: string, hostname: string | null): Promise<void> {
    await this.#call("setPrimaryHostname", () => this.#db.setPrimaryHostname(projectId, hostname));
    const kept = projects.get(projectId);
    projects.delete(projectId);
    if (kept) projects.delete(kept.slug);
  }

  // ── the OAuth provider's grants (oauth-grants.ts), for its store (oauth-store.ts) ──

  /** A grant's JSON as last written, or null. */
  oauthGrant(key: string) {
    return this.#read("oauthGrant", () => this.#grants.get(key, nowSeconds()));
  }
  listOAuthGrants(prefix: string, options: { cursor?: string; limit?: number }) {
    return this.#read("listOAuthGrants", () => this.#grants.list(prefix, options, nowSeconds()));
  }
  /** `expiresAt`: epoch seconds, or null for a grant that never expires. A whole-row write, so
   *  asking it again is safe (oauth-store.ts does). */
  putOAuthGrant(key: string, value: string, expiresAt: number | null) {
    return this.#call("putOAuthGrant", () => this.#grants.put(key, value, expiresAt, nowSeconds()));
  }
  deleteOAuthGrant(key: string) {
    return this.#call("deleteOAuthGrant", () => this.#grants.delete(key));
  }

  #forget(...userIds: (string | undefined)[]): void {
    for (const userId of userIds) if (userId) access.delete(userId);
  }
}

/** KV's clock: epoch seconds. */
const nowSeconds = () => Math.floor(Date.now() / 1000);
