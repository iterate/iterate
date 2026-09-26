// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the deployment's D1 (catalog.ts, one statement or one batch).
// Memos per isolate: a project's id, slug and organization never change, so a hit is kept for the
// isolate's life, and a miss only by a project host's admission, five seconds
// (`getProjectKeepingMisses`); a person's access is kept five seconds — dropped at once here for the
// person a command was made by or for — and a refusal is never memoized: a project not in a memoized
// access set is re-read once before it is refused, so a creation is reachable at once. A memo keeps
// answers, never a read in flight: a request awaiting another's read hangs when that request ends
// first, its I/O cancelled with it (https://developers.cloudflare.com/workers/observability/errors/).
// A call that fails on the platform's side throws ControlPlaneUnavailableError (`d1Fault`), which a
// project host answers 503 (worker.ts).
import { customHostnameCandidatesOf, type ProjectAddress } from "iterate/project-ingress";
import { SqlfuError } from "sqlfu";
import type { Caller } from "../caller.ts";
import { projectHostOf, type AppConfig } from "../app-config.ts";
import type { Env } from "../env.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import {
  type AccessibleRecord,
  ControlPlaneDatabase,
  type IntegrationRouteRecord,
  type OrganizationRecord,
  type ProjectRecord,
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

/** A control-plane call that failed on the PLATFORM's side (`d1Fault`): D1 unreachable, reset,
 *  overloaded or timing out, or workerd's opaque "internal error; reference = …". A refusal the
 *  catalog coded, a constraint, SQL or any other throw is not one: each surfaces as what it is. A
 *  project host answers it 503 (worker.ts). Its message names the method and the cause only (the
 *  wait is `waitedMs`), so the fault alarm groups one failure as one row. */
export class ControlPlaneUnavailableError extends Error {
  override readonly name = "ControlPlaneUnavailableError";
  /** the catalog method called (`project`, `accessibleTo`, …) */
  readonly method: string;
  readonly waitedMs: number;
  /** Whether the same call may be asked again: a read or an idempotent write that D1 says to send
   *  again (oauth-store.ts asks a grant call again once), or a read a holder's deadline gave up on
   *  (`readDeadlineMs`). A write whose answer was lost may have landed, so any other write is not.
   *  An own property, so it reaches an /api client beside the message (iterate/lib's error
   *  channel). */
  readonly retryable: boolean;
  constructor(input: { method: string; waitedMs: number; cause: Error; retryable: boolean }) {
    super(`The control plane failed ${input.method}: ${input.cause.message}`, {
      cause: input.cause,
    });
    this.method = input.method;
    this.waitedMs = input.waitedMs;
    this.retryable = input.retryable;
  }
}

/** Whether D1 failed on the PLATFORM's side, and whether Cloudflare says to send the query again
 *  (https://developers.cloudflare.com/d1/observability/debug-d1/#error-list); undefined for anything
 *  that is this call's own: SQL, a constraint, a type, a missing table. Read from the messages, as
 *  Cloudflare's own retry example does
 *  (https://developers.cloudflare.com/d1/best-practices/retry-queries/): the error's, and its
 *  causes' (sqlfu wraps a D1 error, whose cause is the binding's). Overloaded, timed out, or reset
 *  for its memory or CPU is not sent again: the database is failing every query queued on it, and
 *  a query it gave up on may still be queued. */
export function d1Fault(error: unknown): { retryable: boolean } | undefined {
  const messages: string[] = [];
  for (let cause = error, depth = 0; cause instanceof Error && depth < 3; depth++) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  const text = messages.join("\n");
  if (
    /D1 DB is overloaded|storage operation exceeded timeout|exceeded its (memory|CPU time) limit and was reset|internal error; reference =/.test(
      text,
    )
  )
    return { retryable: false };
  if (
    /Network connection lost|storage caused object to be reset|reset because its code was updated|Replica disconnected|transient issue on remote node|client disconnected/.test(
      text,
    )
  )
    return { retryable: true };
  return undefined;
}

const projectMemo = new Map<string, ProjectRecord>();
/** The refs a project host's admission found no project for, and when (`getProjectKeepingMisses`),
 *  oldest first: each is deleted before it is set again, so a sweep from the front stops at the
 *  first one still kept, and the map holds only what came in the last `MISS_KEPT_MS` — however many
 *  labels a scanner makes up. */
const missMemo = new Map<string, number>();
const MISS_KEPT_MS = 5_000;
/** A project's row, kept under its id and its slug; a miss kept under either is forgotten. */
const memoize = (project: ProjectRecord) => {
  for (const ref of [project.id, project.slug]) {
    projectMemo.set(ref, project);
    missMemo.delete(ref);
  }
};
/** A host's address under projects' own hostnames, hit or miss, kept thirty seconds: a removed
 *  hostname stops routing within that (Cloudflare stops sending it sooner, the custom hostname
 *  deleted first). */
const hostnameMemo = new Map<string, { at: number; address: ProjectAddress | null }>();
const accessMemo = new Map<string, { at: number; record: AccessibleRecord }>();
/** A project's primary hostname by project id, hit or miss, kept thirty seconds (`primaryHostnameOf`). */
const primaryHostnameMemo = new Map<string, { at: number; hostname: string | null }>();

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const callerOf = (caller: Caller) => ({ principal: caller.principal, grant: caller.grant });

/** The control plane as the edge holds it — ONE per request (worker.ts), or per socket (rpc.ts),
 *  over the `DB` binding.
 *
 *  `readDeadlineMs`: how long this holder waits for a read before it throws
 *  ControlPlaneUnavailableError (retryable). `/api` sets one (rpc.ts): its caller is a client that
 *  can ask again, where a read that hangs would hold the call until D1's own 30 s bound. A project
 *  host sets none: a slow answer is still the answer. */
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
   *  throws ControlPlaneUnavailableError. */
  #read<T>(method: string, read: () => Promise<T>): Promise<T> {
    return this.#withinDeadline(method, this.#call(method, read, true));
  }

  /** `read`, or ControlPlaneUnavailableError (retryable) once this holder's `readDeadlineMs` has
   *  passed without its answer, logged as `control-plane.platform-failure-read-deadline`
   *  (scripts/ci/prd-fault-alarm.ts pages on a burst). The read itself runs on, and a memo it
   *  feeds (`accessibleTo`) still gets its answer. */
  async #withinDeadline<T>(method: string, read: Promise<T>): Promise<T> {
    const deadlineMs = this.#readDeadlineMs;
    if (!deadlineMs) return read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            console.warn({
              event: "control-plane.platform-failure-read-deadline",
              method,
              waitedMs: deadlineMs,
            });
            reject(
              new ControlPlaneUnavailableError({
                method,
                waitedMs: deadlineMs,
                cause: new Error(`no answer within ${deadlineMs} ms`),
                retryable: true,
              }),
            );
          }, deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** ONE call on the database, with no deadline. A platform fault (`d1Fault`) becomes
   *  ControlPlaneUnavailableError, retryable when D1 says so and the call is `idempotent` (every
   *  read, and the grant writes), logged once here as `control-plane.platform-failure-d1`
   *  (scripts/ci/prd-fault-alarm.ts pages on a burst). Any other sqlfu error is thrown again with
   *  its message only: its enumerable `query` holds the SQL and its bound values, which the /api
   *  error channel would hand the client (iterate/lib's errors), and a cause passed to `Error` is
   *  not enumerable. */
  async #call<T>(method: string, call: () => Promise<T>, idempotent = false): Promise<T> {
    const started = Date.now();
    try {
      return await call();
    } catch (error) {
      const fault = d1Fault(error);
      if (fault && error instanceof Error) {
        const unavailable = new ControlPlaneUnavailableError({
          method,
          waitedMs: Date.now() - started,
          cause: error,
          retryable: idempotent && fault.retryable,
        });
        console.warn({
          event: "control-plane.platform-failure-d1",
          name: method,
          waitedMs: unavailable.waitedMs,
          retryable: unavailable.retryable,
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
   *  API call's `project`, a grant's id all resolve here. */
  async getProject(ref: string): Promise<ProjectRecord | null> {
    const memoized = projectMemo.get(ref);
    if (memoized) return memoized;
    const project = await this.#read("project", () => this.#db.project(ref));
    if (project) memoize(project);
    return project;
  }

  /** `getProject` for a project host's admission (worker.ts), whose ref is any label under the
   *  wildcard, anyone's to ask for: a scanner sends a few hundred paths to one unknown label within
   *  seconds. So here a MISS is kept too, five seconds per isolate: a burst reads once, plus the
   *  reads already in flight when the first answers. A project created meanwhile is served on the
   *  isolate that created it at once (`createProject` memoizes its row, even while a read that
   *  missed it is in flight) and on any other within those five seconds. Every other caller reads a
   *  miss again: its answer is a refusal, which a creation must lift at once. */
  async getProjectKeepingMisses(ref: string): Promise<ProjectRecord | null> {
    const now = Date.now();
    for (const [missed, at] of missMemo) {
      if (now - at < MISS_KEPT_MS) break;
      missMemo.delete(missed);
    }
    const missedAt = missMemo.get(ref);
    if (missedAt && now - missedAt < MISS_KEPT_MS) return null;
    const project = await this.getProject(ref);
    if (!project && !projectMemo.has(ref)) {
      missMemo.delete(ref);
      missMemo.set(ref, Date.now());
    }
    return project;
  }

  /** The project `url` is a host of — THE INGRESS ROUTING TABLE: the static rules first (app-config.ts
   *  `projectHostOf`: the ingress routing and the project wildcard), then a hostname a project added
   *  itself (project/custom-hostnames.ts): its apex, or one label under it a routing slug
   *  (iterate/project-ingress `customHostnameCandidatesOf`), in ONE catalog read, memoized thirty
   *  seconds per isolate, hit or miss. A deployment that serves no custom hostnames, the platform's
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
    const memoized = hostnameMemo.get(hostname);
    if (memoized && Date.now() - memoized.at < 30_000) return memoized.address;
    const candidates = customHostnameCandidatesOf(hostname);
    const found = await this.#read("projectByHostname", () =>
      this.#db.projectByHostname(candidates.map((candidate) => candidate.hostname)),
    );
    // the row came with it: the admission's next read (getProject) is a memo hit
    if (found) memoize(found.project);
    const custom = found && {
      routingSlug: candidates.find((candidate) => candidate.hostname === found.hostname)!
        .routingSlug,
      project: found.project.id,
      basePath: "",
    };
    hostnameMemo.set(hostname, { at: Date.now(), address: custom });
    return custom;
  }

  /** The connection a provider account's webhooks go to (catalog.ts `routeIntegration`). Never
   *  memoized: a route released and taken by another project routes there on the next delivery. */
  integrationRouteOf(provider: string, externalId: string): Promise<IntegrationRouteRecord | null> {
    return this.#read("integrationRoute", () => this.#db.integrationRoute(provider, externalId));
  }

  /** A project's primary hostname (project/contract.ts `primaryHostname`), or null — memoized
   *  thirty seconds per isolate, hit or miss, so a change reaches the edge's redirect and
   *  `itx.url` within that. */
  async primaryHostnameOf(projectId: string): Promise<string | null> {
    const memoized = primaryHostnameMemo.get(projectId);
    if (memoized && Date.now() - memoized.at < 30_000) return memoized.hostname;
    const hostname = await this.#read("primaryHostnameOf", () =>
      this.#db.primaryHostnameOf(projectId),
    );
    primaryHostnameMemo.set(projectId, { at: Date.now(), hostname });
    return hostname;
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

  /** What a person can access — memoized; `fresh` bypasses the memo (the re-read before a refusal). */
  async accessibleTo(userId: string, fresh = false): Promise<AccessibleRecord> {
    const memoized = accessMemo.get(userId);
    if (!fresh && memoized && Date.now() - memoized.at < 5_000) return memoized.record;
    const read = this.#call("accessibleTo", () => this.#db.accessibleTo(userId), true);
    return this.#withinDeadline(
      "accessibleTo",
      read.then((record) => {
        accessMemo.set(userId, { at: Date.now(), record });
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
   *  the reach's own selection, missing from the memoized access set is re-read once first — the
   *  project may have been created on another isolate within the memo's five seconds. */
  async reachableProjects(
    reach: Reach,
    expected: readonly string[] = [],
  ): Promise<ProjectRecord[]> {
    if (reach === "every") return this.#read("projects", () => this.#db.projects());
    if ("userId" in reach) {
      const { userId, projectIds } = reach;
      const named = [...expected, ...(projectIds || [])];
      let record = await this.accessibleTo(userId);
      if (!named.every((id) => record.projects.some((project) => project.id === id)))
        record = await this.accessibleTo(userId, true);
      return projectIds
        ? record.projects.filter((project) => projectIds.includes(project.id))
        : record.projects;
    }
    const rows = await Promise.all(reach.projectIds.map((projectId) => this.getProject(projectId)));
    return rows.filter((row): row is ProjectRecord => !!row);
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

  listOrganizations() {
    return this.#read("organizations", () => this.#db.organizations());
  }
  getOrganization(organizationId: string) {
    return this.#read("organization", () => this.#db.organization(organizationId));
  }
  listMembers(organizationId: string) {
    return this.#read("members", () => this.#db.members(organizationId));
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
      this.#db.createOrganization(callerOf(caller), input),
    );
    this.#forget(caller.principal?.actor);
    if (input.ownerId) accessMemo.clear(); // the operator's: named by id or email
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
    accessMemo.clear(); // the name rides every member's access record, not just the caller's
    return organization;
  }
  async deleteOrganization(caller: Caller, organizationId: string): Promise<void> {
    await this.#call("deleteOrganization", () =>
      this.#db.deleteOrganization(callerOf(caller), organizationId),
    );
    accessMemo.clear(); // every member's access changed
  }
  /** Answers the id the membership holds (the caller may have named the person by email). */
  async addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<string> {
    const userId = await this.#call("addMember", () =>
      this.#db.addMember(callerOf(caller), organizationId, input),
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
  ): Promise<ProjectRecord> {
    const project = await this.#call("createProject", () =>
      this.#db.createProject(callerOf(caller), input),
    );
    memoize(project);
    this.#forget(caller.principal?.actor);
    return project;
  }

  /** The project `caller` may delete (catalog.ts `projectToDelete`), or a refusal. */
  projectToDelete(caller: Caller, ref: string): Promise<ProjectRecord> {
    return this.#call("projectToDelete", () => this.#db.projectToDelete(callerOf(caller), ref));
  }
  /** A project's row goes (catalog.ts `deleteProject`): forgotten here at once, and on every other
   *  isolate when it next reads the catalog — a row it memoized stays until that isolate goes. */
  async deleteProject(caller: Caller, ref: string): Promise<ProjectRecord> {
    const project = await this.#call("deleteProject", () =>
      this.#db.deleteProject(callerOf(caller), ref),
    );
    projectMemo.delete(project.id);
    projectMemo.delete(project.slug);
    accessMemo.clear(); // every member's reach just changed
    return project;
  }

  // ── a project's own hostnames, which project/processor.ts claims and releases ──

  claimHostname(projectId: string, hostname: string): Promise<void> {
    return this.#call("claimHostname", () => this.#db.claimHostname(projectId, hostname));
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
  /** Release one account's route, only while the connection at `path` holds it (catalog.ts
   *  `releaseIntegrationRoute`). */
  releaseIntegrationRoute(
    provider: string,
    externalId: string,
    projectId: string,
    path: string,
  ): Promise<void> {
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
   *  the edge's redirect and `itx.url` read it within `primaryHostnameOf`'s thirty seconds. */
  setPrimaryHostname(projectId: string, hostname: string | null): Promise<void> {
    return this.#call("setPrimaryHostname", () => this.#db.setPrimaryHostname(projectId, hostname));
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
   *  asking it again is safe (`idempotent`). */
  putOAuthGrant(key: string, value: string, expiresAt: number | null) {
    return this.#call(
      "putOAuthGrant",
      () => this.#grants.put(key, value, expiresAt, nowSeconds()),
      true,
    );
  }
  deleteOAuthGrant(key: string) {
    return this.#call("deleteOAuthGrant", () => this.#grants.delete(key), true);
  }

  #forget(...userIds: (string | undefined)[]): void {
    for (const userId of userIds) if (userId) accessMemo.delete(userId);
  }
}

/** KV's clock: epoch seconds. */
const nowSeconds = () => Math.floor(Date.now() / 1000);
