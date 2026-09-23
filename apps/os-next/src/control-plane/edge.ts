// src/control-plane/edge.ts — THE CONTROL PLANE AS THE EDGE HOLDS IT: every question the stateless
// worker asks — which project is this slug, may this session reach it, who is this email — and every
// command it relays, each ONE call on the `control-plane` facet on `global:/` (durable-object.ts),
// reached by identity over the worker's binding. Two memos per isolate: a project's id, slug and
// organization never change, so a hit is kept for the isolate's life (a miss never is); a person's
// reach is kept five seconds — dropped at once here for the person a command was made by or for —
// and a refusal is never memoized: a project not in a memoized reach is re-read once before it is
// refused, so a creation is reachable at once.
import type { Caller } from "iterate/next/principal";
import { GLOBAL_PROJECT_ID } from "../context/paths.ts";
import { DurableObjectNameCodec, type IterateContextNamespace } from "../iterate-context.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import type {
  Asker,
  MemberRecord,
  OrganizationRecord,
  ProjectRecord,
  ReachRecord,
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
const reachMemo = new Map<string, { at: number; value: Promise<ReachRecord> }>();

/** Who asked, as the control plane records it: the caller's principal and its connection. */
const askerOf = (caller: Caller): Asker => ({ principal: caller.principal, grant: caller.grant });

/** The control plane as the edge holds it — ONE per request (worker.ts, rpc.ts), over the
 *  worker's binding. */
export class ControlPlane {
  readonly #root;
  constructor(namespace: IterateContextNamespace) {
    this.#root = namespace.getByName(
      DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: "/" }),
    );
  }

  /** ONE method of the facet, awaited here: the stub's `invoke` answers workerd's RPC promise,
   *  which a caller must never hold (a pipelined copy of a refusal would go unhandled), and is
   *  typed as the RPC wrapper over the context's method — so the answer is asserted here, once, to
   *  the plain data the facet's method returns (catalog.ts), which the wire copies. */
  async #call<T>(method: string, ...args: unknown[]): Promise<T> {
    const answer = await this.#root.invoke(
      ["itx", "facets", ["get", "control-plane"], [method, ...args]],
      [],
      { principal: null },
    );
    return answer as T;
  }

  // ── the reads ──

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

  /** What a person reaches — memoized; `fresh` bypasses the memo (the re-read before a refusal). */
  reach(userId: string, fresh = false): Promise<ReachRecord> {
    const memoized = reachMemo.get(userId);
    if (!fresh && memoized && Date.now() - memoized.at < 5_000) return memoized.value;
    const value = this.#call<ReachRecord>("reach", userId);
    value.catch(() => reachMemo.delete(userId)); // a failed read is nobody's answer — its caller sees it
    reachMemo.set(userId, { at: Date.now(), value });
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
    const reaches = (record: ReachRecord) => record.projects.some((project) => project.id === id);
    return reaches(await this.reach(reach.userId)) || reaches(await this.reach(reach.userId, true));
  }

  /** The projects `reach` reaches: every one for the admin secret; the user's, with their role;
   *  the named ones (a name the catalog never heard of is no record). */
  async reachableProjects(reach: Reach): Promise<ProjectRecord[]> {
    if (reach === "every") return this.#call<ProjectRecord[]>("projects");
    if ("userId" in reach) {
      const { projects } = await this.reach(reach.userId);
      return reach.projectIds
        ? projects.filter((project) => reach.projectIds!.includes(project.id))
        : projects;
    }
    const rows = await Promise.all(reach.projectIds.map((projectId) => this.getProject(projectId)));
    return rows.filter((row): row is ProjectRecord => !!row);
  }

  /** Whether `reach` may hold `orgId`'s context: the admin every one; a user the ones they belong
   *  to — re-read once before a refusal. */
  async reachesOrg(reach: Reach, orgId: string): Promise<boolean> {
    if (reach === "every") return true;
    if (!("userId" in reach)) return false;
    const belongs = (record: ReachRecord) => record.orgs.some((org) => org.id === orgId);
    return belongs(await this.reach(reach.userId)) || belongs(await this.reach(reach.userId, true));
  }

  listOrganizations(): Promise<OrganizationRecord[]> {
    return this.#call("organizations");
  }
  getOrganization(orgId: string): Promise<OrganizationRecord | null> {
    return this.#call("organization", orgId);
  }
  listMembers(orgId: string): Promise<MemberRecord[]> {
    return this.#call("members", orgId);
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
    return this.#call("createUser", askerOf(caller), input);
  }
  /** What sign-in calls (password-and-code-sign-in.ts, issuer-session.ts): the catalog first. */
  async ensureUser(email: string): Promise<UserRecord> {
    return (await this.getUser(email)) ?? this.createUser({ principal: null }, { email });
  }
  /** A verified sign-in's identity (identity.ts): link once by email, then by subject. */
  linkIdentity(provider: IdentityProvider, subject: string, email: string): Promise<UserRecord> {
    return this.#call("linkIdentity", { principal: null }, { provider, subject, email });
  }

  async createOrganization(
    caller: Caller,
    input: { name: string; id?: string; ownerId?: string },
  ): Promise<OrganizationRecord> {
    const organization = await this.#call<OrganizationRecord>(
      "createOrganization",
      askerOf(caller),
      input,
    );
    this.#forget(caller.principal?.actor);
    if (input.ownerId) reachMemo.clear(); // the operator's: named by id or email
    return organization;
  }
  async renameOrganization(
    caller: Caller,
    orgId: string,
    name: string,
  ): Promise<OrganizationRecord> {
    const organization = await this.#call<OrganizationRecord>(
      "renameOrganization",
      askerOf(caller),
      orgId,
      name,
    );
    this.#forget(caller.principal?.actor);
    return organization;
  }
  async deleteOrganization(caller: Caller, orgId: string): Promise<void> {
    await this.#call("deleteOrganization", askerOf(caller), orgId);
    reachMemo.clear(); // every member's reach changed
  }
  async addMember(
    caller: Caller,
    orgId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<void> {
    this.#forget(await this.#call<string>("addMember", askerOf(caller), orgId, input));
  }
  async removeMember(caller: Caller, orgId: string, input: { userId: string }): Promise<void> {
    this.#forget(await this.#call<string>("removeMember", askerOf(caller), orgId, input));
  }
  /** A project: the catalog's row, which owes its root the creation request (catalog.ts); the
   *  dash watches the project facet's live state. */
  async createProject(
    caller: Caller,
    input: {
      project: string;
      orgId?: string;
      restoreProjectId?: string;
      configRepoTemplate?: string;
    },
  ): Promise<ProjectRecord> {
    const project = await this.#call<ProjectRecord>("createProject", askerOf(caller), input);
    projectMemo.set(project.id, project);
    projectMemo.set(project.slug, project);
    this.#forget(caller.principal?.actor);
    return project;
  }

  #forget(...userIds: (string | undefined)[]): void {
    for (const userId of userIds) if (userId) reachMemo.delete(userId);
  }
}
