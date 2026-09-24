// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the `CONTROL_PLANE` singleton Durable Object (durable-object.ts),
// reached by binding (`getByName("global")`). Two memos per isolate: a project's id, slug and
// organization never change, so a hit is kept for the isolate's life (a miss never is); a person's
// access is kept five seconds — dropped at once here for the person a command was made by or for —
// and a refusal is never memoized: a project not in a memoized access set is re-read once before it
// is refused, so a creation is reachable at once. Every READ is bounded (READ_TIMEOUT_MS): one that
// times out or fails on the platform's side throws ControlPlaneUnavailableError, which a project
// host's admission models (last-known-project.ts, worker.ts); a command is never cut short.
import { customHostnameCandidatesOf, type ProjectAddress } from "iterate/project-ingress";
import type { Caller } from "../caller.ts";
import { projectHostOf, type AppConfig } from "../app-config.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import { isRetryableTransportError } from "../retryable-error.ts";
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

/** How long the edge waits for one control-plane READ before the platform counts as down: 3 s. In
 *  prd the singleton answers in 23–30 ms at the median, 266 ms at p99 and ~300 ms at p999 (a wake
 *  after a deploy's reset); the slowest of 14,622 calls on 2026-09-23/24 took 1.25 s (Workers Logs,
 *  `ControlPlaneDurableObject` jsrpc wall time). On 2026-09-24 it was unreachable for 188 s and each
 *  call failed only after 12–15 s ("internal error; reference = …"), so every visitor of every
 *  project host waited that long for a 5xx. Three seconds is over twice the slowest healthy call and
 *  a quarter of the platform's own give-up. A command (a write) is not bounded: one abandoned
 *  here may still land, and its caller would report a change that happened as failed. */
const READ_TIMEOUT_MS = 3_000;

/** A control-plane READ that did not answer within READ_TIMEOUT_MS, or that failed on the platform's
 *  side: cut at the transport (retryable-error.ts: "Network connection lost.", a Durable Object
 *  reset) or workerd's opaque "internal error; reference = …", what the 2026-09-24 outage threw. A
 *  refusal the catalog coded, or any other throw, is not one and surfaces as what it is. The
 *  project host's admission models it (worker.ts); everywhere else it surfaces, after 3 s instead of
 *  the platform's 12–15. */
export class ControlPlaneUnavailableError extends Error {
  override readonly name = "ControlPlaneUnavailableError";
  /** the Durable Object method read (`project`, `accessibleTo`, …) */
  readonly method: string;
  readonly waitedMs: number;
  /** The cause's transport flag, kept: oauth-store.ts asks a cut grant read again once. */
  readonly retryable: boolean;
  constructor(method: string, waitedMs: number, cause?: Error) {
    super(
      cause
        ? `The control plane failed ${method} after ${waitedMs} ms: ${cause.message}`
        : `The control plane did not answer ${method} within ${READ_TIMEOUT_MS} ms`,
      { cause },
    );
    this.method = method;
    this.waitedMs = waitedMs;
    this.retryable = isRetryableTransportError(cause);
  }
}

const projectMemo = new Map<string, ProjectRecord>();
/** A host's address under projects' own hostnames, hit or miss, kept thirty seconds: a removed
 *  hostname stops routing within that (Cloudflare stops sending it sooner, the custom hostname
 *  deleted first). */
const hostnameMemo = new Map<string, { at: number; value: Promise<ProjectAddress | null> }>();
const accessMemo = new Map<string, { at: number; value: Promise<AccessibleRecord> }>();

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const callerOf = (caller: Caller) => ({ principal: caller.principal, grant: caller.grant });

/** The control plane as the edge holds it — ONE per request (worker.ts, rpc.ts), over the
 *  `CONTROL_PLANE` binding. */
export class ControlPlane {
  readonly #namespace: DurableObjectNamespace<ControlPlaneDurableObject>;
  #stub: DurableObjectStub<ControlPlaneDurableObject>;
  constructor(namespace: DurableObjectNamespace<ControlPlaneDurableObject>) {
    this.#namespace = namespace;
    this.#stub = namespace.getByName("global");
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

  /** ONE read (`#call`), BOUNDED: past READ_TIMEOUT_MS, or failed on the platform's side, it throws
   *  ControlPlaneUnavailableError. Workers RPC takes no abort signal, so a call that times out is
   *  abandoned, not cancelled; the stub it hung on is replaced, as a cut one is. */
  async #read<T>(method: string, ...args: unknown[]): Promise<T> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#stub = this.#namespace.getByName("global");
        reject(new ControlPlaneUnavailableError(method, Date.now() - started));
      }, READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.#call<T>(method, ...args), timedOut]);
    } catch (error) {
      if (
        error instanceof Error &&
        (isRetryableTransportError(error) ||
          error.message.startsWith("internal error; reference ="))
      )
        throw new ControlPlaneUnavailableError(method, Date.now() - started, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A project by id or by slug — THE lookup: a URL's `/projects/<slug>`, a hostname's label, an
   *  API call's `project`, a grant's id all resolve here. */
  async getProject(ref: string): Promise<ProjectRecord | null> {
    const memoized = projectMemo.get(ref);
    if (memoized) return memoized;
    const project = await this.#read<ProjectRecord | null>("project", ref);
    if (project) {
      projectMemo.set(project.id, project);
      projectMemo.set(project.slug, project);
    }
    return project;
  }

  /** The project `url` is a host of — THE INGRESS ROUTING TABLE: the static rules first (app-config.ts
   *  `projectHostOf`: the ingress routing and the project wildcard), then a hostname a project added
   *  itself (project/custom-hostnames.ts): its apex, or one label under it an app
   *  (iterate/project-ingress `customHostnameCandidatesOf`), in ONE catalog read.
   *  A deployment that serves no custom hostnames, the platform's own origins and anything under its
   *  reserved zones never reach the table. What worker.ts admits a project host with, and what
   *  consent.ts binds a project's CIMD client to. */
  async projectHostOf(
    config: AppConfig,
    url: URL,
    platformOrigin: string,
  ): Promise<ProjectAddress | null> {
    const routed = projectHostOf(config, url, platformOrigin);
    if (routed || !config.customHostnames) return routed;
    if (url.origin === platformOrigin || url.origin === config.urls.mcp) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      config.customHostnames.reservedZones.some(
        (zone) => hostname === zone || hostname.endsWith(`.${zone}`),
      )
    )
      return null;
    const memoized = hostnameMemo.get(hostname);
    if (memoized && Date.now() - memoized.at < 30_000) return memoized.value;
    const candidates = customHostnameCandidatesOf(hostname);
    const value = this.#call<{ hostname: string; project: ProjectRecord } | null>(
      "projectByHostname",
      candidates.map((candidate) => candidate.hostname),
    ).then(
      (found) =>
        found && {
          app: candidates.find((candidate) => candidate.hostname === found.hostname)!.app,
          project: found.project.id,
          basePath: "",
        },
    );
    value.catch(() => hostnameMemo.delete(hostname));
    hostnameMemo.set(hostname, { at: Date.now(), value });
    return value;
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
    if (!fresh && memoized && Date.now() - memoized.at < 5_000) return memoized.value;
    const value = this.#read<AccessibleRecord>("accessibleTo", userId);
    value.catch(() => accessMemo.delete(userId)); // a failed read is nobody's answer — its caller sees it
    accessMemo.set(userId, { at: Date.now(), value });
    return value;
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
    projectMemo.set(project.id, project);
    projectMemo.set(project.slug, project);
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
