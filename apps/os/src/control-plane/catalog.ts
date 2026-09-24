// src/control-plane/catalog.ts — THE CONTROL PLANE DATABASE: every user, identity, organization,
// membership and project of the deployment, as tables in the SQLite of the `CONTROL_PLANE` singleton
// Durable Object (durable-object.ts). It is a NORMAL Durable Object, not D1: we don't need D1's
// multi-writer/replica story for a low-write control plane, and we don't want a database to operate
// per environment — the DO is created on first touch, its storage is automatic, and one object gives
// strong consistency and read-your-writes for free (two creates of one slug can't both pass, because a
// DO runs one synchronous block at a time). Reads scale later behind an eventual KV cache in front of
// this object. The tables are the truth; every read is a query, every write ONE SYNCHRONOUS BLOCK —
// the check and the insert with no `await` between them. No `await` in this file: a unit test drives
// it over node:sqlite (catalog.test.ts).
import { codedError } from "iterate/next/lib";
import type { Caller as PrincipalCaller } from "iterate/next/principal";
import type { SqlStorageHandle } from "iterate/next/stream/processor";
import type { OrganizationRole } from "../organization/contract.ts";
import type { IdentityProvider } from "./contract.ts";

/** WHO asked: the caller's principal and grant, as the edge hands them over. The operator is the
 *  admin secret's principal (oauth.ts) — actor `admin`, no email. */
export type Caller = Pick<PrincipalCaller, "principal" | "grant">;
export const isOperator = (caller: Caller) =>
  caller.principal?.actor === "admin" && !caller.principal.email;

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
const emailAddress = (email: string) => email.trim().toLowerCase();

const newId = (prefix: "user" | "org" | "prj") =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export type UserRecord = { id: string; email: string };
/** A project, addressed by `id` everywhere (the context's name, a grant's list, the API); `slug` is
 *  the DNS label of its hostnames; `role` is the reader's, when read through their memberships. */
export type ProjectRecord = {
  id: string;
  slug: string;
  orgId: string;
  role?: OrganizationRole;
};
/** An organization, with how many projects it holds and, read through a membership, the role. */
export type OrganizationRecord = {
  id: string;
  name: string;
  role?: OrganizationRole;
  projects: number;
};
export type MemberRecord = { userId: string; email: string; role: OrganizationRole };
/** What a person can access: their organizations and every project of those, with their role. */
export type AccessibleRecord = { organizations: OrganizationRecord[]; projects: ProjectRecord[] };

export class ControlPlaneDatabase {
  constructor(private readonly sql: SqlStorageHandle) {
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (provider, user_id))",
      "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (org_id, user_id))",
      "CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id)",
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id)",
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
  organization(organizationId: string): OrganizationRecord | null {
    return (
      this.#rows<OrganizationRecord>(
        "SELECT id, name, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM organizations o WHERE id = ?",
        organizationId,
      )[0] ?? null
    );
  }
  organizations(): OrganizationRecord[] {
    return this.#rows<OrganizationRecord>(
      "SELECT id, name, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM organizations o ORDER BY name, id",
    );
  }
  members(organizationId: string): MemberRecord[] {
    return this.#rows<MemberRecord>(
      "SELECT m.user_id AS userId, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.email",
      organizationId,
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
  /** What a person can access: the organizations they belong to — the first by name is where a
   *  project goes when none is named — and every project of those, with their role. */
  accessibleTo(userId: string): AccessibleRecord {
    return {
      organizations: this.#rows<OrganizationRecord>(
        "SELECT o.id, o.name, m.role, (SELECT count(*) FROM projects WHERE org_id = o.id) AS projects FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name, o.id",
        userId,
      ),
      projects: this.#rows<ProjectRecord>(
        "SELECT p.id, p.slug, p.org_id AS orgId, m.role FROM projects p JOIN memberships m ON m.org_id = p.org_id WHERE m.user_id = ? ORDER BY p.slug",
        userId,
      ),
    };
  }

  // ── the writes: each one synchronous block — check, then write ──

  /** Find-or-create the person for an email. The operator may pin the id (the replay of an older
   *  directory); an email already known answers its own person, pinned id or not — the replay
   *  follows the answered id (scripts/replay-directory.ts `userIdOf`). */
  createUser(caller: Caller, input: { email: string; id?: string }): UserRecord {
    if (input.id) this.#requireOperator(caller, "pin a user's id");
    const email = emailAddress(input.email);
    const known = this.user(email);
    if (known) return known;
    if (input.id && this.user(input.id))
      throw codedError("INVALID_INPUT", `The user id ${input.id} belongs to another email.`);
    return this.#insertUser(input.id || newId("user"), email);
  }
  #insertUser(userId: string, email: string): UserRecord {
    this.sql.exec("INSERT INTO users (id, email) VALUES (?, ?)", userId, email);
    return { id: userId, email };
  }

  /** A verified sign-in: link once by verified email, then resolve by the provider's stable
   *  subject. A linked subject's changed email follows it, unless another person holds that email;
   *  a second subject of the same provider cannot adopt an already-linked person. Takes no caller —
   *  it is the sign-in system linking a verified identity, never a person's own command. */
  linkIdentity(input: { provider: IdentityProvider; subject: string; email: string }): UserRecord {
    const { provider, subject } = input;
    const email = emailAddress(input.email);
    const linked = this.identity(provider, subject);
    if (linked) {
      if (linked.email === email) return linked;
      const holder = this.user(email);
      if (holder && holder.id !== linked.id)
        throw codedError("IDENTITY_CONFLICT", "This email belongs to another account.");
      this.sql.exec("UPDATE users SET email = ? WHERE id = ?", email, linked.id);
      return { id: linked.id, email };
    }
    const holder = this.user(email);
    if (
      holder &&
      this.#rows("SELECT 1 FROM identities WHERE provider = ? AND user_id = ?", provider, holder.id)
        .length
    )
      throw codedError("IDENTITY_CONFLICT", "This email belongs to another linked account.");
    const user = holder || this.#insertUser(newId("user"), email);
    this.sql.exec(
      "INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)",
      provider,
      subject,
      user.id,
    );
    return user;
  }

  /** A new organization, the caller its owner. The operator may pin the id and name another owner,
   *  or none (the deployment's own); a pinned organization that exists is answered as it is. */
  createOrganization(
    caller: Caller,
    input: { name: string; id?: string; ownerId?: string },
  ): OrganizationRecord {
    if (input.id || input.ownerId)
      this.#requireOperator(caller, "pin an organization's id or name its owner");
    // named by id or email; the membership holds the id
    const owner = input.ownerId ? this.user(input.ownerId) : null;
    if (input.ownerId && !owner)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.ownerId)} to own it.`);
    const ownerId =
      owner?.id ??
      (isOperator(caller) ? null : this.#requireUser(caller, "create an organization"));
    const pinned = input.id && this.organization(input.id);
    if (pinned) return pinned;
    const organizationId = input.id || newId("org");
    this.#insertOrganization(organizationId, input.name.trim(), ownerId);
    const record: OrganizationRecord = { id: organizationId, name: input.name.trim(), projects: 0 };
    if (ownerId && ownerId === caller.principal?.actor) record.role = "owner";
    return record;
  }
  #insertOrganization(organizationId: string, name: string, ownerId: string | null): void {
    this.sql.exec("INSERT INTO organizations (id, name) VALUES (?, ?)", organizationId, name);
    if (ownerId) this.#insertMembership(organizationId, ownerId, "owner");
  }
  #insertMembership(organizationId: string, userId: string, role: OrganizationRole): void {
    this.sql.exec(
      "INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role",
      organizationId,
      userId,
      role,
    );
  }

  renameOrganization(caller: Caller, organizationId: string, name: string): OrganizationRecord {
    this.#requireOwner(caller, organizationId, "rename");
    this.sql.exec("UPDATE organizations SET name = ? WHERE id = ?", name.trim(), organizationId);
    return this.organization(organizationId)!;
  }

  /** Delete an organization — only while it holds no project; its memberships go with it. */
  deleteOrganization(caller: Caller, organizationId: string): void {
    this.#requireOwner(caller, organizationId, "delete");
    const { projects } = this.organization(organizationId)!;
    if (projects)
      throw codedError(
        "INVALID_INPUT",
        `This organization still holds ${projects} project${projects === 1 ? "" : "s"}.`,
      );
    this.sql.exec("DELETE FROM memberships WHERE org_id = ?", organizationId);
    this.sql.exec("DELETE FROM organizations WHERE id = ?", organizationId);
  }

  /** Add a person, named by id or email, or change their role; answers the id the membership holds. */
  addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ): string {
    this.#requireOwner(caller, organizationId, "add a member to");
    const userId = this.user(input.userId)?.id;
    if (!userId)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.userId)} to add.`);
    const role = this.#role(organizationId, userId);
    if (role === input.role) return userId;
    if (role === "owner" && this.#owners(organizationId) === 1)
      throw codedError("INVALID_INPUT", "An organization keeps at least one owner.");
    this.#insertMembership(organizationId, userId, input.role);
    return userId;
  }

  /** Remove a person, named by id or email; the last owner stays. Answers the id removed. */
  removeMember(caller: Caller, organizationId: string, input: { userId: string }): string {
    this.#requireOwner(caller, organizationId, "remove a member from");
    const userId = this.user(input.userId)?.id;
    const role = userId && this.#role(organizationId, userId);
    if (!userId || !role) throw codedError("INVALID_INPUT", "Not a member of that organization.");
    if (role === "owner" && this.#owners(organizationId) === 1)
      throw codedError("INVALID_INPUT", "An organization keeps at least one owner.");
    this.sql.exec(
      "DELETE FROM memberships WHERE org_id = ? AND user_id = ?",
      organizationId,
      userId,
    );
    return userId;
  }

  /** A project named `project` (slugified into its hostname label): in the organization named (a
   *  member's, or any for the operator) or the caller's own — their first by name, made on first use
   *  and named after their email's local part (the deployment's own for the operator). A slug is ONE
   *  project across every organization: the same organization's again is the same project, another's
   *  is PROJECT_NAME_TAKEN — decided before anything is made. The project's own creation (its config
   *  repo, its seed) is its root's saga, opened by the caller (session.ts) after this returns. */
  createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ): ProjectRecord {
    const restoring = input.restoreProjectId;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty restore id is refused, never read as "mint a new one"
    if (restoring !== undefined) {
      this.#requireOperator(caller, "restore a project's archived id (the admin secret)");
      if (!/^prj_[A-Za-z0-9_-]+$/.test(restoring))
        throw codedError("INVALID_INPUT", "The restored project id is invalid.");
    }
    const slug = projectSlug(input.project);
    if (!slug) throw codedError("INVALID_INPUT", "The project name is empty or invalid.");
    const operator = isOperator(caller);
    const userId = operator ? null : this.#requireUser(caller, "create a project");
    let organizationId: string | null;
    if (input.organizationId) {
      if (
        !this.organization(input.organizationId) ||
        (userId && !this.#role(input.organizationId, userId))
      )
        throw codedError("FORBIDDEN", "You cannot create a project in that organization.");
      organizationId = input.organizationId;
    } else
      organizationId = operator
        ? ADMIN_ORG_ID
        : (this.accessibleTo(userId!).organizations[0]?.id ?? null);
    const held = this.#rows<ProjectRecord>(
      "SELECT id, slug, org_id AS orgId FROM projects WHERE slug = ?",
      slug,
    )[0];
    if (held && held.orgId !== organizationId)
      throw codedError("PROJECT_NAME_TAKEN", `The project name '${slug}' is already taken.`);
    if (held && restoring && held.id !== restoring)
      throw codedError(
        "IDENTITY_CONFLICT",
        `The project '${slug}' exists with id ${held.id}, not the restored id ${restoring}.`,
      );
    if (held) return held;
    const idHolder = restoring && this.project(restoring);
    if (idHolder)
      throw codedError(
        "IDENTITY_CONFLICT",
        `The restored project id ${restoring} already belongs to '${idHolder.slug}'.`,
      );
    if (!organizationId) {
      organizationId = newId("org");
      this.#insertOrganization(organizationId, this.user(userId!)!.email.split("@")[0]!, userId);
    } else if (operator && !input.organizationId && !this.organization(organizationId))
      this.#insertOrganization(organizationId, "admin", null);
    const projectId = restoring || newId("prj");
    this.sql.exec(
      "INSERT INTO projects (id, slug, org_id) VALUES (?, ?, ?)",
      projectId,
      slug,
      organizationId,
    );
    return { id: projectId, slug, orgId: organizationId };
  }

  // ── who may ──

  #role(organizationId: string, userId: string): OrganizationRole | undefined {
    return this.#rows<{ role: OrganizationRole }>(
      "SELECT role FROM memberships WHERE org_id = ? AND user_id = ?",
      organizationId,
      userId,
    )[0]?.role;
  }
  #owners(organizationId: string): number {
    return this.#rows(
      "SELECT 1 FROM memberships WHERE org_id = ? AND role = 'owner'",
      organizationId,
    ).length;
  }
  #requireOperator(caller: Caller, what: string): void {
    if (!isOperator(caller)) throw codedError("FORBIDDEN", `Only the operator may ${what}.`);
  }
  /** The signed-in person behind the caller — the operator acting as one included. */
  #requireUser(caller: Caller, verb: string): string {
    const actor = caller.principal?.actor;
    if (!actor || isOperator(caller))
      throw codedError("FORBIDDEN", `A user session is required to ${verb}.`);
    return actor;
  }
  /** An owner of an organization that exists, or the operator. */
  #requireOwner(caller: Caller, organizationId: string, verb: string): void {
    if (!this.organization(organizationId))
      throw codedError("FORBIDDEN", `You cannot ${verb} that organization.`);
    if (isOperator(caller)) return;
    const actor = this.#requireUser(caller, `${verb} an organization`);
    if (this.#role(organizationId, actor) !== "owner")
      throw codedError("FORBIDDEN", `Only an owner can ${verb} an organization.`);
  }
}
