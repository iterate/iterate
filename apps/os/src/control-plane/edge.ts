// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the `CONTROL_PLANE` singleton Durable Object (durable-object.ts),
// reached by binding (`getByName("global")`). Two memos per isolate: a project's id, slug and
// organization never change, so a hit is kept for the isolate's life (a miss never is); a person's
// access is kept five seconds — dropped at once here for the person a command was made by or for —
// and a refusal is never memoized: a project not in a memoized access set is re-read once before it
// is refused, so a creation is reachable at once.
import type { Caller } from "iterate/next/principal";
import type { OrganizationRole } from "../organization/contract.ts";
import { isRetryableTransportError } from "../retryable-error.ts";
import type { ControlPlaneDurableObject } from "./durable-object.ts";
import type {
  AccessibleRecord,
  Caller as ControlPlaneCaller,
  MemberRecord,
  OrganizationRecord,
  ProjectRecord,
  UserRecord,
} from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";

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

const projectMemo = new Map<string, ProjectRecord>();
const accessMemo = new Map<string, { at: number; value: Promise<AccessibleRecord> }>();

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const callerOf = (caller: Caller): ControlPlaneCaller => ({
  principal: caller.principal,
  grant: caller.grant,
});

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
   *  same way. A holder that
   *  outlives one call (rpc.ts: one per socket, for its whole life) would otherwise stay broken
   *  until it closed; the call that failed still throws, and the next one reaches the new object. */
  async #call<T>(method: string, ...args: unknown[]): Promise<T> {
    const stub = this.#stub as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    try {
      return (await stub[method]!(...args)) as T;
    } catch (error) {
      if (isRetryableTransportError(error)) this.#stub = this.#namespace.getByName("global");
      throw error;
    }
  }

  /** A project by id or by slug — THE lookup: a URL's `/projects/<slug>`, a hostname's label, an
   *  API call's `project`, a grant's id all resolve here. */
  async getProject(ref: string): Promise<ProjectRecord | null> {
    const memoized = projectMemo.get(ref);
    if (memoized) return memoized;
    const project = await this.#call<ProjectRecord | null>("project", ref);
    if (project) {
      projectMemo.set(project.id, project);
      projectMemo.set(project.slug, project);
    }
    return project;
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
    const value = this.#call<AccessibleRecord>("accessibleTo", userId);
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
   *  the named ones (a name the catalog never heard of is no record). */
  async reachableProjects(reach: Reach): Promise<ProjectRecord[]> {
    if (reach === "every") return this.#call<ProjectRecord[]>("projects");
    if ("userId" in reach) {
      const { projects } = await this.accessibleTo(reach.userId);
      return reach.projectIds
        ? projects.filter((project) => reach.projectIds!.includes(project.id))
        : projects;
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
    return this.#call("organizations");
  }
  getOrganization(organizationId: string): Promise<OrganizationRecord | null> {
    return this.#call("organization", organizationId);
  }
  listMembers(organizationId: string): Promise<MemberRecord[]> {
    return this.#call("members", organizationId);
  }
  /** A user by id or by email. */
  getUser(ref: string): Promise<UserRecord | null> {
    return this.#call("user", ref);
  }
  /** The user a provider's subject names. */
  identity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    return this.#call("identity", provider, subject);
  }
  listUsers(): Promise<UserRecord[]> {
    return this.#call("users");
  }

  // ── the commands: each one call, under the caller ──

  /** Find-or-create the person for an email; the operator may pin the id. */
  createUser(caller: Caller, input: { email: string; id?: string }): Promise<UserRecord> {
    return this.#call("createUser", callerOf(caller), input);
  }
  /** What sign-in calls (password-and-code-sign-in.ts, issuer-session.ts): the catalog first. */
  async ensureUser(email: string): Promise<UserRecord> {
    return (await this.getUser(email)) ?? this.createUser({ principal: null }, { email });
  }
  /** A verified sign-in's identity (identity.ts): link once by email, then by subject. The
   *  system's own write — no caller. */
  linkIdentity(provider: IdentityProvider, subject: string, email: string): Promise<UserRecord> {
    return this.#call("linkIdentity", { provider, subject, email });
  }

  async createOrganization(
    caller: Caller,
    input: { name: string; id?: string; ownerId?: string },
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

  #forget(...userIds: (string | undefined)[]): void {
    for (const userId of userIds) if (userId) accessMemo.delete(userId);
  }
}
