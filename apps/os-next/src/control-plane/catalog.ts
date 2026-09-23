// src/control-plane/catalog.ts — THE CATALOG: every user, identity, organization, membership and
// project of the deployment, as tables in the SQLite of the `control-plane` facet on `global:/`
// (durable-object.ts). The tables are the truth. Every read is a query; every write is ONE
// SYNCHRONOUS BLOCK — the check (a slug taken? an owner asking?) and the insert with no `await`
// between them, so no other call can run in the gap: a Durable Object runs one synchronous block at
// a time. A write also records, in the same block, the FACTS it owes other contexts — the
// organization's record, the member's account, the root's own log, a project's own root — in the
// `outbox` table; the facet delivers them right after (durable-object.ts), so a fact is never lost
// to a crash between the write and its delivery. No `await` in this file: a unit test drives it over node:sqlite
// (catalog.test.ts).
import { codedError } from "iterate/next/lib";
import type { EventInput, SqlStorageHandle, StreamEventInput } from "iterate/next/stream/processor";
import { GLOBAL_PROJECT_ID } from "../context/paths.ts";
import type { OrganizationContract, OrganizationRole } from "../organization/contract.ts";
import type { ProjectContract } from "../project/contract.ts";
import type { ControlPlaneContract, IdentityProvider } from "./contract.ts";

/** WHO asked: the caller's principal and grant, as the edge hands them over. Every fact the write
 *  owes is landed under it, so the audit on each context names who asked. The operator is the
 *  admin secret's principal (oauth.ts) — actor `admin`, no email. */
export type Asker = { principal: { actor: string; email?: string } | null; grant?: string };
export const isAdmin = (asker: Asker) =>
  asker.principal?.actor === "admin" && !asker.principal.email;

/** The deployment's own organization: the operator's projects go here; it has no members. */
export const ADMIN_ORG_ID = "org_admin";

/** A project's slug from its name — THE ONE slugging: lowercase, non-alphanumeric → dash, runs
 *  collapsed, ends trimmed. Empty when nothing DNS-safe survives. */
export const projectSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** An email's address — THE ONE spelling: trimmed, lower-cased. */
export const emailAddress = (email: string) => email.trim().toLowerCase();

const newId = (prefix: "user" | "org" | "prj") =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export type UserRecord = { id: string; email: string };
/** A project, addressed by `id` everywhere (the context's name, a grant's list, the API); `slug` is
 *  the DNS label of its hostnames; `role` is the reader's, when read through their memberships. */
export type ProjectRecord = { id: string; slug: string; orgId: string; role?: OrganizationRole };
/** An organization, with how many projects it holds and, read through a membership, the role. */
export type OrganizationRecord = {
  id: string;
  name: string;
  role?: OrganizationRole;
  projects: number;
};
export type MemberRecord = { userId: string; email: string; role: OrganizationRole };
/** What a person reaches: their organizations and every project of those, with their role. */
export type ReachRecord = { orgs: OrganizationRecord[]; projects: ProjectRecord[] };

/** A context owed facts: an account, an organization or the root log in the global namespace, or a
 *  project's root. */
export type OwedContext = { projectId: string; path: string };

/** A fact owed to a context: the processor row it needs, the event, and who asked. */
export type OutboxRow = OwedContext & {
  id: number;
  processor: string | null;
  event: string;
  asker: string;
};

type OrganizationFact = EventInput<typeof OrganizationContract>;

export class Catalog {
  constructor(private readonly sql: SqlStorageHandle) {
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (provider, user_id))",
      "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (org_id, user_id))",
      "CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id)",
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id)",
      "CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, path TEXT NOT NULL, processor TEXT, event TEXT NOT NULL, asker TEXT NOT NULL)",
    ])
      sql.exec(statement);
  }

  /** A query's rows, named by the query's own column aliases to match `T`. */
  #rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  // ── the reads ──

  /** A user by id or by email. */
  user(ref: string): UserRecord | null {
    return (
      this.#rows<UserRecord>(
        "SELECT id, email FROM users WHERE id = ? OR email = ?",
        ref,
        emailAddress(ref),
      )[0] ?? null
    );
  }
  users(): UserRecord[] {
    return this.#rows<UserRecord>("SELECT id, email FROM users ORDER BY email");
  }
  /** The user a provider's subject names. */
  identity(provider: IdentityProvider, subject: string): UserRecord | null {
    return (
      this.#rows<UserRecord>(
        "SELECT u.id, u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?",
        provider,
        subject,
      )[0] ?? null
    );
  }
  organization(orgId: string): OrganizationRecord | null {
    return (
      this.#rows<OrganizationRecord>(
        "SELECT id, name, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM organizations o WHERE id = ?",
        orgId,
      )[0] ?? null
    );
  }
  organizations(): OrganizationRecord[] {
    return this.#rows<OrganizationRecord>(
      "SELECT id, name, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM organizations o ORDER BY name, id",
    );
  }
  members(orgId: string): MemberRecord[] {
    return this.#rows<MemberRecord>(
      "SELECT m.user_id AS userId, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.email",
      orgId,
    );
  }
  /** A project by id or by slug. */
  project(ref: string): ProjectRecord | null {
    return (
      this.#rows<ProjectRecord>(
        "SELECT id, slug, org_id AS orgId FROM projects WHERE id = ? OR slug = ?",
        ref,
        ref,
      )[0] ?? null
    );
  }
  projects(): ProjectRecord[] {
    return this.#rows<ProjectRecord>(
      "SELECT id, slug, org_id AS orgId FROM projects ORDER BY slug",
    );
  }
  /** What a person reaches: the organizations they belong to — the first by name is where a
   *  project goes when none is named — and every project of those, with their role. */
  reach(userId: string): ReachRecord {
    return {
      orgs: this.#rows<OrganizationRecord>(
        "SELECT o.id, o.name, m.role, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name, o.id",
        userId,
      ),
      projects: this.#rows<ProjectRecord>(
        "SELECT p.id, p.slug, p.org_id AS orgId, m.role FROM projects p JOIN memberships m ON m.org_id = p.org_id WHERE m.user_id = ? ORDER BY p.slug",
        userId,
      ),
    };
  }

  // ── the outbox: the facts a write owes, recorded with the write ──

  #owe(
    { projectId, path }: OwedContext,
    processor: "account" | "organization" | "project" | null,
    asker: Asker,
    ...events: StreamEventInput[]
  ): void {
    for (const event of events)
      this.sql.exec(
        "INSERT INTO outbox (project_id, path, processor, event, asker) VALUES (?, ?, ?, ?, ?)",
        projectId,
        path,
        processor,
        JSON.stringify(event),
        JSON.stringify(asker),
      );
  }
  #onOrganization(orgId: string, asker: Asker, ...facts: OrganizationFact[]): void {
    const context = { projectId: GLOBAL_PROJECT_ID, path: `/organizations/${orgId}` };
    this.#owe(context, "organization", asker, ...facts);
  }
  #onAccount(userId: string, asker: Asker, ...facts: OrganizationFact[]): void {
    this.#owe(
      { projectId: GLOBAL_PROJECT_ID, path: `/users/${userId}` },
      "account",
      asker,
      ...facts,
    );
  }
  #record(asker: Asker, ...records: EventInput<typeof ControlPlaneContract>[]): void {
    this.#owe({ projectId: GLOBAL_PROJECT_ID, path: "/" }, null, asker, ...records);
  }
  #onProject(projectId: string, asker: Asker, request: EventInput<typeof ProjectContract>): void {
    this.#owe({ projectId, path: "/" }, "project", asker, request);
  }

  /** The highest outbox row so far — a write's facts are the rows after it. */
  outboxHead(): number {
    return this.#rows<{ id: number }>("SELECT coalesce(max(id), 0) AS id FROM outbox")[0]!.id;
  }
  /** The contexts owed a fact after `after` (every one for 0). */
  owed(after: number): OwedContext[] {
    return this.#rows<OwedContext>(
      "SELECT DISTINCT project_id AS projectId, path FROM outbox WHERE id > ?",
      after,
    );
  }
  /** Every fact owed to one context, oldest first. */
  outbox({ projectId, path }: OwedContext): OutboxRow[] {
    return this.#rows<OutboxRow>(
      "SELECT id, project_id AS projectId, path, processor, event, asker FROM outbox WHERE project_id = ? AND path = ? ORDER BY id",
      projectId,
      path,
    );
  }
  delivered(ids: number[]): void {
    for (const id of ids) this.sql.exec("DELETE FROM outbox WHERE id = ?", id);
  }

  // ── the writes: each one synchronous block — check, write, owe ──

  /** Find-or-create the person for an email. The operator may pin the id (the replay of an older
   *  directory); an email already known answers its own person, pinned id or not — the replay
   *  follows the answered id (scripts/replay-directory.ts `userIdOf`). */
  createUser(asker: Asker, input: { email: string; id?: string }): UserRecord {
    if (input.id) this.#requireAdmin(asker, "pin a user's id");
    const email = emailAddress(input.email);
    const known = this.user(email);
    if (known) return known;
    if (input.id && this.user(input.id))
      throw codedError("INVALID_INPUT", `The user id ${input.id} belongs to another email.`);
    return this.#insertUser(asker, input.id || newId("user"), email);
  }
  #insertUser(asker: Asker, userId: string, email: string): UserRecord {
    this.sql.exec("INSERT INTO users (id, email) VALUES (?, ?)", userId, email);
    this.#record(asker, {
      type: "events.iterate.com/control-plane/user-created",
      payload: { userId, email },
    });
    return { id: userId, email };
  }

  /** A verified sign-in: link once by verified email, then resolve by the provider's stable
   *  subject. A linked subject's changed email follows it, unless another person holds that email;
   *  a second subject of the same provider cannot adopt an already-linked person. */
  linkIdentity(
    asker: Asker,
    input: { provider: IdentityProvider; subject: string; email: string },
  ): UserRecord {
    const { provider, subject } = input;
    const email = emailAddress(input.email);
    const linked = this.identity(provider, subject);
    if (linked) {
      if (linked.email === email) return linked;
      const holder = this.user(email);
      if (holder && holder.id !== linked.id)
        throw codedError("IDENTITY_CONFLICT", "This email belongs to another account.");
      this.sql.exec("UPDATE users SET email = ? WHERE id = ?", email, linked.id);
      this.#record(asker, {
        type: "events.iterate.com/control-plane/user-email-changed",
        payload: { userId: linked.id, email },
      });
      return { id: linked.id, email };
    }
    const holder = this.user(email);
    if (
      holder &&
      this.#rows("SELECT 1 FROM identities WHERE provider = ? AND user_id = ?", provider, holder.id)
        .length
    )
      throw codedError("IDENTITY_CONFLICT", "This email belongs to another linked account.");
    const user = holder || this.#insertUser(asker, newId("user"), email);
    this.sql.exec(
      "INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)",
      provider,
      subject,
      user.id,
    );
    this.#record(asker, {
      type: "events.iterate.com/control-plane/identity-linked",
      payload: { userId: user.id, provider, subject },
    });
    return user;
  }

  /** A new organization, the asker its owner. The operator may pin the id and name another owner,
   *  or none (the deployment's own); a pinned organization that exists is answered as it is. */
  createOrganization(
    asker: Asker,
    input: { name: string; id?: string; ownerId?: string },
  ): OrganizationRecord {
    if (input.id || input.ownerId)
      this.#requireAdmin(asker, "pin an organization's id or name its owner");
    // named by id or email; the membership holds the id
    const owner = input.ownerId ? this.user(input.ownerId) : null;
    if (input.ownerId && !owner)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.ownerId)} to own it.`);
    const ownerId =
      owner?.id ?? (isAdmin(asker) ? null : this.#requireUser(asker, "create an organization"));
    const pinned = input.id && this.organization(input.id);
    if (pinned) return pinned;
    const orgId = input.id || newId("org");
    this.#insertOrganization(asker, orgId, input.name.trim(), ownerId);
    const record: OrganizationRecord = { id: orgId, name: input.name.trim(), projects: 0 };
    if (ownerId && ownerId === asker.principal?.actor) record.role = "owner";
    return record;
  }
  #insertOrganization(asker: Asker, orgId: string, name: string, ownerId: string | null): void {
    this.sql.exec("INSERT INTO organizations (id, name) VALUES (?, ?)", orgId, name);
    this.#onOrganization(orgId, asker, {
      type: "events.iterate.com/organization/created",
      payload: { name },
    });
    this.#record(asker, {
      type: "events.iterate.com/control-plane/organization-created",
      payload: { orgId, name, ownerId },
    });
    if (ownerId) this.#insertMembership(asker, orgId, ownerId, "owner");
  }
  #insertMembership(asker: Asker, orgId: string, userId: string, role: OrganizationRole): void {
    this.sql.exec(
      "INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role",
      orgId,
      userId,
      role,
    );
    const fact: OrganizationFact = {
      type: "events.iterate.com/organization/member-added",
      payload: { orgId, userId, role },
    };
    this.#onOrganization(orgId, asker, fact);
    this.#onAccount(userId, asker, fact);
    this.#record(asker, {
      type: "events.iterate.com/control-plane/member-added",
      payload: { orgId, userId, role },
    });
  }

  renameOrganization(asker: Asker, orgId: string, name: string): OrganizationRecord {
    this.#requireOwner(asker, orgId, "rename");
    this.sql.exec("UPDATE organizations SET name = ? WHERE id = ?", name.trim(), orgId);
    this.#onOrganization(orgId, asker, {
      type: "events.iterate.com/organization/renamed",
      payload: { name: name.trim() },
    });
    this.#record(asker, {
      type: "events.iterate.com/control-plane/organization-renamed",
      payload: { orgId, name: name.trim() },
    });
    return this.organization(orgId)!;
  }

  /** Delete an organization — only while it holds no project; its memberships go with it, off
   *  every member's account. Its context outlives it as the record. */
  deleteOrganization(asker: Asker, orgId: string): void {
    this.#requireOwner(asker, orgId, "delete");
    const { projects } = this.organization(orgId)!;
    if (projects)
      throw codedError(
        "INVALID_INPUT",
        `This organization still holds ${projects} project${projects === 1 ? "" : "s"}.`,
      );
    for (const { userId } of this.members(orgId))
      this.#onAccount(userId, asker, {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId, userId },
      });
    this.sql.exec("DELETE FROM memberships WHERE org_id = ?", orgId);
    this.sql.exec("DELETE FROM organizations WHERE id = ?", orgId);
    this.#onOrganization(orgId, asker, {
      type: "events.iterate.com/organization/deleted",
      payload: {},
    });
    this.#record(asker, {
      type: "events.iterate.com/control-plane/organization-deleted",
      payload: { orgId },
    });
  }

  /** Add a person, named by id or email, or change their role; answers the id the membership holds. */
  addMember(
    asker: Asker,
    orgId: string,
    input: { userId: string; role: OrganizationRole },
  ): string {
    this.#requireOwner(asker, orgId, "add a member to");
    const userId = this.user(input.userId)?.id;
    if (!userId)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.userId)} to add.`);
    const role = this.#role(orgId, userId);
    if (role === input.role) return userId;
    if (role === "owner" && this.#owners(orgId) === 1)
      throw codedError("INVALID_INPUT", "An organization keeps at least one owner.");
    this.#insertMembership(asker, orgId, userId, input.role);
    return userId;
  }

  /** Remove a person, named by id or email; the last owner stays. Answers the id removed. */
  removeMember(asker: Asker, orgId: string, input: { userId: string }): string {
    this.#requireOwner(asker, orgId, "remove a member from");
    const userId = this.user(input.userId)?.id;
    const role = userId && this.#role(orgId, userId);
    if (!userId || !role) throw codedError("INVALID_INPUT", "Not a member of that organization.");
    if (role === "owner" && this.#owners(orgId) === 1)
      throw codedError("INVALID_INPUT", "An organization keeps at least one owner.");
    this.sql.exec("DELETE FROM memberships WHERE org_id = ? AND user_id = ?", orgId, userId);
    const fact: OrganizationFact = {
      type: "events.iterate.com/organization/member-removed",
      payload: { orgId, userId },
    };
    this.#onOrganization(orgId, asker, fact);
    this.#onAccount(userId, asker, fact);
    this.#record(asker, {
      type: "events.iterate.com/control-plane/member-removed",
      payload: { orgId, userId },
    });
    return userId;
  }

  /** A project named `project` (slugified into its hostname label): in the organization named (a
   *  member's, or any for the operator) or the asker's own — their first by name, made on first
   *  use and named after their email's local part (the deployment's own for the operator). A slug
   *  is ONE project across every organization: the same organization's again is the same project,
   *  another's is PROJECT_NAME_TAKEN — decided before anything is made. Every answer owes the
   *  project's root a `project/create-requested`: its own saga (src/project/processor.ts) runs the
   *  creation — the config repo, its seed — and takes a request after the certificate as a harmless
   *  fact and one after a failure as a new attempt, so asking again is how a failed one is retried. */
  createProject(
    asker: Asker,
    input: {
      project: string;
      orgId?: string;
      restoreProjectId?: string;
      configRepoTemplate?: string;
    },
  ): ProjectRecord {
    const restoring = input.restoreProjectId;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty restore id is refused, never read as "mint a new one"
    if (restoring !== undefined) {
      this.#requireAdmin(asker, "restore a project's archived id (the admin secret)");
      if (!/^prj_[A-Za-z0-9_-]+$/.test(restoring))
        throw codedError("INVALID_INPUT", "The restored project id is invalid.");
    }
    const slug = projectSlug(input.project);
    if (!slug) throw codedError("INVALID_INPUT", "The project name is empty or invalid.");
    const admin = isAdmin(asker);
    const userId = admin ? null : this.#requireUser(asker, "create a project");
    let orgId: string | null;
    if (input.orgId) {
      if (!this.organization(input.orgId) || (userId && !this.#role(input.orgId, userId)))
        throw codedError("FORBIDDEN", "You cannot create a project in that organization.");
      orgId = input.orgId;
    } else orgId = admin ? ADMIN_ORG_ID : (this.reach(userId!).orgs[0]?.id ?? null);
    const held = this.#rows<ProjectRecord>(
      "SELECT id, slug, org_id AS orgId FROM projects WHERE slug = ?",
      slug,
    )[0];
    if (held && held.orgId !== orgId)
      throw codedError("PROJECT_NAME_TAKEN", `The project name '${slug}' is already taken.`);
    if (held && restoring && held.id !== restoring)
      throw codedError(
        "IDENTITY_CONFLICT",
        `The project '${slug}' exists with id ${held.id}, not the restored id ${restoring}.`,
      );
    const request = (project: ProjectRecord) =>
      this.#onProject(project.id, asker, {
        type: "events.iterate.com/project/create-requested",
        payload: {
          slug: project.slug,
          orgId: project.orgId,
          configRepoTemplate: input.configRepoTemplate,
        },
      });
    if (held) {
      request(held);
      return held;
    }
    const idHolder = restoring && this.project(restoring);
    if (idHolder)
      throw codedError(
        "IDENTITY_CONFLICT",
        `The restored project id ${restoring} already belongs to '${idHolder.slug}'.`,
      );
    if (!orgId) {
      orgId = newId("org");
      this.#insertOrganization(asker, orgId, this.user(userId!)!.email.split("@")[0]!, userId);
    } else if (admin && !input.orgId && !this.organization(orgId))
      this.#insertOrganization(asker, orgId, "admin", null);
    const projectId = restoring || newId("prj");
    this.sql.exec(
      "INSERT INTO projects (id, slug, org_id) VALUES (?, ?, ?)",
      projectId,
      slug,
      orgId,
    );
    this.#onOrganization(orgId, asker, {
      type: "events.iterate.com/organization/project-created",
      payload: { projectId, slug },
    });
    this.#record(asker, {
      type: "events.iterate.com/control-plane/project-created",
      payload: { projectId, slug, orgId },
    });
    const project = { id: projectId, slug, orgId };
    request(project);
    return project;
  }

  // ── who may ──

  #role(orgId: string, userId: string): OrganizationRole | undefined {
    return this.#rows<{ role: OrganizationRole }>(
      "SELECT role FROM memberships WHERE org_id = ? AND user_id = ?",
      orgId,
      userId,
    )[0]?.role;
  }
  #owners(orgId: string): number {
    return this.#rows("SELECT 1 FROM memberships WHERE org_id = ? AND role = 'owner'", orgId)
      .length;
  }
  #requireAdmin(asker: Asker, what: string): void {
    if (!isAdmin(asker)) throw codedError("FORBIDDEN", `Only the operator may ${what}.`);
  }
  /** The signed-in person behind the asker — the operator acting as one included. */
  #requireUser(asker: Asker, verb: string): string {
    const actor = asker.principal?.actor;
    if (!actor || isAdmin(asker))
      throw codedError("FORBIDDEN", `A user session is required to ${verb}.`);
    return actor;
  }
  /** An owner of an organization that exists, or the operator. */
  #requireOwner(asker: Asker, orgId: string, verb: string): void {
    if (!this.organization(orgId))
      throw codedError("FORBIDDEN", `You cannot ${verb} that organization.`);
    if (isAdmin(asker)) return;
    const actor = this.#requireUser(asker, `${verb} an organization`);
    if (this.#role(orgId, actor) !== "owner")
      throw codedError("FORBIDDEN", `Only an owner can ${verb} an organization.`);
  }
}
