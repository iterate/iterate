// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the `CONTROL_PLANE` singleton Durable Object (durable-object.ts),
// reached by binding (`getByName("global")`). Memos per isolate: a project's id, slug and
// organization never change, so a hit is kept for the isolate's life, and a miss only by a project
// host's admission, five seconds (`getProjectKeepingMisses`); a person's access is kept five
// seconds — dropped at once here for the person a command was made by or for — and a refusal is
// never memoized: a project not in a memoized access set is re-read once before it is refused, so
// a creation is reachable at once. A READ that fails on the platform's side throws
// ControlPlaneUnavailableError, which a project host's admission models (last-known-project.ts,
// worker.ts).
import { customHostnameCandidatesOf, type ProjectAddress } from "iterate/project-ingress";
import type { Caller } from "../caller.ts";
import { projectHostOf, type AppConfig } from "../app-config.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import { isDeployReset, isRetryableTransportError } from "../retryable-error.ts";
import type { ControlPlaneDurableObject } from "./durable-object.ts";
import type {
  AccessibleRecord,
  InvitationPreview,
  InvitationRecord,
  MemberRecord,
  OrganizationRecord,
  ProjectRecord,
  UserRecord,
} from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";
import type { OAuthGrantListing } from "./oauth-grants.ts";

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

/** A control-plane READ that failed on the platform's side: cut at the transport ("Network
 *  connection lost.", retryable-error.ts) or workerd's opaque "internal error; reference = …", what
 *  the 2026-09-24 outage threw after 12–15 s. A deploy's reset of the Durable Object
 *  (`isDeployReset`) is our own expected cut, not the platform being down, and a refusal the catalog
 *  coded or any other throw is not one either: each surfaces as what it is. A project host's
 *  admission models it (last-known-project.ts, worker.ts). Its message names the method and the
 *  cause only (the wait is `waitedMs`), so the fault alarm groups one failure as one row. */
export class ControlPlaneUnavailableError extends Error {
  override readonly name = "ControlPlaneUnavailableError";
  /** the Durable Object method read (`project`, `accessibleTo`, …) */
  readonly method: string;
  readonly waitedMs: number;
  /** The cause's transport flag, kept (oauth-store.ts asks a cut grant read again once), or true
   *  for a read a holder's deadline gave up on (`readDeadlineMs`): it may answer when asked again.
   *  An own property, so it reaches an /api client beside the message (iterate/lib's error channel). */
  readonly retryable: boolean;
  constructor(input: { method: string; waitedMs: number; cause: Error; retryable?: boolean }) {
    const { method, waitedMs, cause, retryable = isRetryableTransportError(cause) } = input;
    super(`The control plane failed ${method}: ${cause.message}`, { cause });
    this.method = method;
    this.waitedMs = waitedMs;
    this.retryable = retryable;
  }
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
const hostnameMemo = new Map<string, { at: number; value: Promise<ProjectAddress | null> }>();
const accessMemo = new Map<string, { at: number; value: Promise<AccessibleRecord> }>();

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const callerOf = (caller: Caller) => ({ principal: caller.principal, grant: caller.grant });

/** The control plane as the edge holds it — ONE per request (worker.ts, rpc.ts), over the
 *  `CONTROL_PLANE` binding.
 *
 *  `readDeadlineMs`: how long this holder waits for a read before it throws
 *  ControlPlaneUnavailableError (retryable). `/api` sets one (rpc.ts): its caller is a client that
 *  can ask again, where a read that hangs would hold the call until the transport gives up. A
 *  project host's admission sets none: a copy stands in for its slow reads, and with no copy a
 *  slow answer is still the answer (last-known-project.ts). */
export class ControlPlane {
  readonly #namespace: DurableObjectNamespace<ControlPlaneDurableObject>;
  #stub: DurableObjectStub<ControlPlaneDurableObject>;
  readonly #readDeadlineMs: number | undefined;
  constructor(
    namespace: DurableObjectNamespace<ControlPlaneDurableObject>,
    { readDeadlineMs }: { readDeadlineMs?: number } = {},
  ) {
    this.#namespace = namespace;
    this.#stub = namespace.getByName("global");
    this.#readDeadlineMs = readDeadlineMs;
  }

  /** ONE method of the registry DO, awaited here so a pipelined RPC promise is never held (a copy of
   *  a refusal would go unhandled); the answer is the plain data the method returns (catalog.ts),
   *  which the wire copies. Typed loosely here; the method name and args are pinned by the callers'
   *  own generics.
   *
   *  A BROKEN STUB is replaced (retryable-error.ts): a deploy resetting this Durable Object for its
   *  new code cuts the call at the transport, and the stub that threw fails every later call the
   *  same way. A holder that outlives one call (rpc.ts: one per socket, for its whole life) would
   *  otherwise stay broken until it closed; the call that failed still throws, and the next one
   *  reaches the new object. */
  async #call<T>(method: string, ...args: unknown[]): Promise<T> {
    const stub = this.#stub as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    try {
      return (await stub[method]!(...args)) as T;
    } catch (error) {
      if (isRetryableTransportError(error)) this.#stub = this.#namespace.getByName("global");
      throw error;
    }
  }

  /** ONE read (`#call`): failed on the platform's side, or unanswered at this holder's
   *  `readDeadlineMs`, it throws ControlPlaneUnavailableError. */
  #read<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.#withinDeadline(method, this.#request<T>(method, ...args));
  }

  /** `read`, or ControlPlaneUnavailableError (retryable) once this holder's `readDeadlineMs` has
   *  passed without its answer, logged as `control-plane.platform-failure-read-deadline`
   *  (scripts/ci/prd-fault-alarm.ts pages on a burst). The read itself runs on: a memo that holds
   *  it (`accessibleTo`) still gets its answer, for holders with no deadline as well. */
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

  /** The read itself, with no deadline: what an isolate memo keeps, since holders with and without
   *  a deadline share it. */
  async #request<T>(method: string, ...args: unknown[]): Promise<T> {
    const started = Date.now();
    try {
      return await this.#call<T>(method, ...args);
    } catch (error) {
      if (
        error instanceof Error &&
        !isDeployReset(error) &&
        (isRetryableTransportError(error) ||
          error.message.startsWith("internal error; reference ="))
      )
        throw new ControlPlaneUnavailableError({
          method,
          waitedMs: Date.now() - started,
          cause: error,
        });
      throw error;
    }
  }

  /** A project by id or by slug — THE lookup: a URL's `/projects/<slug>`, a hostname's label, an
   *  API call's `project`, a grant's id all resolve here. */
  async getProject(ref: string): Promise<ProjectRecord | null> {
    const memoized = projectMemo.get(ref);
    if (memoized) return memoized;
    const project = await this.#read<ProjectRecord | null>("project", ref);
    if (project) memoize(project);
    return project;
  }

  /** `getProject` for a project host's admission (last-known-project.ts), whose ref is any label
   *  under the wildcard, anyone's to ask for: a scanner sends a few hundred paths to one unknown
   *  label within seconds. So here a MISS is kept too, five seconds per isolate: a burst reads once,
   *  plus the reads already in flight when the first answers. A project created meanwhile is served
   *  on the isolate that created it at once (`createProject` memoizes its row, even while a read
   *  that missed it is in flight) and on any other within those five seconds. Every other caller
   *  reads a miss again: its answer is a refusal, which a creation must lift at once. The answer is
   *  kept, never the read in flight: a request awaiting another's read hangs when that request
   *  ends first, its I/O cancelled with it
   *  (https://developers.cloudflare.com/workers/observability/errors/). */
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
   *  (iterate/project-ingress `customHostnameCandidatesOf`), in ONE catalog read.
   *  A deployment that serves no custom hostnames, the platform's own origins and anything under its
   *  reserved zones never reach the table. What consent.ts binds a project's CIMD client to; a
   *  request's own admission reads the same two halves through last-known-project.ts
   *  `admitProjectHost`, which falls back to the control plane's KV copies when a read fails. */
  async projectHostOf(
    config: AppConfig,
    url: URL,
    platformOrigin: string,
  ): Promise<ProjectAddress | null> {
    return (
      projectHostOf(config, url, platformOrigin) ?? this.customHostOf(config, url, platformOrigin)
    );
  }

  /** The table half of `projectHostOf`: the project that added `url`'s hostname itself, or null —
   *  one catalog read, memoized thirty seconds per isolate, hit or miss. Also last-known-project.ts's. */
  async customHostOf(
    config: AppConfig,
    url: URL,
    platformOrigin: string,
  ): Promise<ProjectAddress | null> {
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
    if (memoized && Date.now() - memoized.at < 30_000)
      return this.#withinDeadline("projectByHostname", memoized.value);
    const candidates = customHostnameCandidatesOf(hostname);
    const value = this.#request<{ hostname: string; project: ProjectRecord } | null>(
      "projectByHostname",
      candidates.map((candidate) => candidate.hostname),
    ).then((found) => {
      if (!found) return null;
      // the row came with it: the admission's next read (getProject) is a memo hit
      memoize(found.project);
      return {
        routingSlug: candidates.find((candidate) => candidate.hostname === found.hostname)!
          .routingSlug,
        project: found.project.id,
        basePath: "",
      };
    });
    value.catch(() => hostnameMemo.delete(hostname));
    hostnameMemo.set(hostname, { at: Date.now(), value });
    return this.#withinDeadline("projectByHostname", value);
  }

  /** The id a ref names: an id is self-evident (`prj_…` — a slug never holds an underscore), a
   *  slug resolves through the catalog, and a slug nobody holds passes through for the reach check
   *  to refuse. */
  async projectIdOf(ref: string): Promise<string> {
    if (ref.startsWith("prj_")) return ref;
    return (await this.getProject(ref))?.id ?? ref;
  }

  /** What a person can access — memoized; `fresh` bypasses the memo (the re-read before a refusal). */
  accessibleTo(userId: string, fresh = false): Promise<AccessibleRecord> {
    const memoized = accessMemo.get(userId);
    if (!fresh && memoized && Date.now() - memoized.at < 5_000)
      return this.#withinDeadline("accessibleTo", memoized.value);
    const value = this.#request<AccessibleRecord>("accessibleTo", userId);
    value.catch(() => accessMemo.delete(userId)); // a failed read is nobody's answer — its caller sees it
    accessMemo.set(userId, { at: Date.now(), value });
    return this.#withinDeadline("accessibleTo", value);
  }

  /** Whether `reach` reaches `ref` — the admission behind `projects.get` (session.ts), a `/mcp`
   *  tool's `project` and a project host's visitor (worker.ts). The admin reaches a project the
   *  catalog never heard of; a named reach is its list; a user's is their memberships — re-read
   *  once before a refusal. */
  async reachesProject(reach: Reach, ref: string): Promise<boolean> {
    if (reach === "every") return true;
    const id = await this.projectIdOf(ref);
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
      return (await this.reachesProject(reach, id)) ? id : null;
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
    if (reach === "every") return this.#read<ProjectRecord[]>("projects");
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

  listOrganizations(): Promise<OrganizationRecord[]> {
    return this.#read("organizations");
  }
  getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    return this.#read("organization", organizationId);
  }
  listMembers(organizationId: string): Promise<MemberRecord[]> {
    return this.#read("members", organizationId);
  }
  /** What an invitation link opens, for `userId` (null: nobody signed in) — by the token's hash. */
  getInvitation(tokenHash: string, userId: string | null): Promise<InvitationPreview | null> {
    return this.#read("invitation", tokenHash, userId);
  }
  /** A user by id or by email. */
  getUser(ref: string): Promise<UserRecord | null> {
    return this.#read("user", ref);
  }
  /** The user a provider's subject names. */
  identity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    return this.#read("identity", provider, subject);
  }
  listUsers(): Promise<UserRecord[]> {
    return this.#read("users");
  }

  // ── the commands: each one call, under the caller ──

  /** Find-or-create the person for an email. No caller: sign-in (`ensureUser`) and the operator's
   *  `session.users` (session.ts refuses everyone else) are its only callers. */
  createUser(input: { email: string }): Promise<UserRecord> {
    return this.#call("createUser", input);
  }
  /** What sign-in calls (password-and-code-sign-in.ts, issuer-session.ts): the catalog first. */
  async ensureUser(email: string): Promise<UserRecord> {
    return (await this.getUser(email)) ?? this.createUser({ email });
  }
  /** A verified sign-in's identity (identity.ts): link once by email, then by subject. The
   *  system's own write — no caller. */
  linkIdentity(provider: IdentityProvider, subject: string, email: string): Promise<UserRecord> {
    return this.#call("linkIdentity", { provider, subject, email });
  }

  async createOrganization(
    caller: Caller,
    input: { name: string; ownerId?: string },
  ): Promise<OrganizationRecord> {
    const organization = await this.#call<OrganizationRecord>(
      "createOrganization",
      callerOf(caller),
      input,
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
    const organization = await this.#call<OrganizationRecord>(
      "renameOrganization",
      callerOf(caller),
      organizationId,
      name,
    );
    accessMemo.clear(); // the name rides every member's access record, not just the caller's
    return organization;
  }
  async deleteOrganization(caller: Caller, organizationId: string): Promise<void> {
    await this.#call("deleteOrganization", callerOf(caller), organizationId);
    accessMemo.clear(); // every member's access changed
  }
  /** Answers the id the membership holds (the caller may have named the person by email). */
  async addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<string> {
    const userId = await this.#call<string>("addMember", callerOf(caller), organizationId, input);
    this.#forget(userId);
    return userId;
  }
  /** Answers the id removed. */
  async removeMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string },
  ): Promise<string> {
    const userId = await this.#call<string>(
      "removeMember",
      callerOf(caller),
      organizationId,
      input,
    );
    this.#forget(userId);
    return userId;
  }
  createInvitation(
    caller: Caller,
    organizationId: string,
    input: { tokenHash: string; role: OrganizationRole; emailHint?: string; expiresAt: number },
  ): Promise<InvitationRecord> {
    return this.#call("createInvitation", callerOf(caller), organizationId, input);
  }
  revokeInvitation(
    caller: Caller,
    organizationId: string,
    invitationId: string,
  ): Promise<InvitationRecord> {
    return this.#call("revokeInvitation", callerOf(caller), organizationId, invitationId);
  }
  /** The caller joins the organization the link opens; their access is re-read at once. */
  async acceptInvitation(caller: Caller, tokenHash: string) {
    const accepted = await this.#call<{
      invitation: InvitationRecord;
      userId: string;
      role: OrganizationRole;
      accepted: boolean;
    }>("acceptInvitation", callerOf(caller), tokenHash);
    this.#forget(accepted.userId);
    return accepted;
  }
  /** A project: the catalog claims the slug and mints the id; the caller (session.ts) then opens the
   *  project's own creation saga on its root. */
  async createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ): Promise<ProjectRecord> {
    const project = await this.#call<ProjectRecord>("createProject", callerOf(caller), input);
    memoize(project);
    this.#forget(caller.principal?.actor);
    return project;
  }

  // ── the OAuth provider's grants (oauth-grants.ts), for its store (oauth-store.ts) ──

  /** A grant's JSON as last written, or null. */
  oauthGrant(key: string): Promise<string | null> {
    return this.#read("oauthGrant", key);
  }
  listOAuthGrants(
    prefix: string,
    options: { cursor?: string; limit?: number },
  ): Promise<OAuthGrantListing> {
    return this.#read("listOAuthGrants", prefix, options);
  }
  /** `expiresAt`: epoch seconds, or null for a grant that never expires. */
  putOAuthGrant(key: string, value: string, expiresAt: number | null): Promise<void> {
    return this.#call("putOAuthGrant", key, value, expiresAt);
  }
  deleteOAuthGrant(key: string): Promise<void> {
    return this.#call("deleteOAuthGrant", key);
  }

  #forget(...userIds: (string | undefined)[]): void {
    for (const userId of userIds) if (userId) accessMemo.delete(userId);
  }
}
