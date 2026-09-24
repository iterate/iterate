// src/control-plane/catalog.ts — THE CONTROL PLANE DATABASE: every user, identity, organization,
// membership and project of the deployment, as tables in the SQLite of the `CONTROL_PLANE` singleton
// Durable Object (durable-object.ts). It is a NORMAL Durable Object, not D1: we don't need D1's
// multi-writer/replica story for a low-write control plane, and we don't want a database to operate
// per environment — the DO is created on first touch, its storage is automatic, and one object gives
// strong consistency and read-your-writes for free (two creates of one slug can't both pass, because a
// DO runs one synchronous block at a time). Reads scale later behind an eventual KV cache in front of
// this object. The tables are the truth; every read is a query, every write ONE SYNCHRONOUS BLOCK —
// the check and the insert with no `await` between them. No `await` in this file: a unit test drives
// it over node:sqlite (catalog.test.ts) — so the clock comes in as `now` (epoch ms) and an
// invitation's token comes in already hashed (session.ts mints and hashes it).
import { codedError } from "iterate/lib";
import type { SqlStorageHandle } from "iterate/stream/processor";
import type { Caller as PrincipalCaller } from "../caller.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import type { IdentityProvider } from "./contract.ts";

/** WHO asked: the caller's principal and grant, as the edge hands them over. The operator is the
 *  admin secret's principal (oauth.ts) — actor `admin`, no email. */
export type Caller = Pick<PrincipalCaller, "principal" | "grant">;
const isOperator = (caller: Caller) =>
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

const newId = (prefix: "user" | "org" | "prj" | "inv") =>
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
/** An invitation to an organization, as its owners see it: the link's own secret is never stored,
 *  only its SHA-256 (`token_hash`), so an invitation is shown once — at creation — and afterwards
 *  known by `id`. `emailHint` is who the owner meant it for: a note, not a check — the link admits
 *  whoever signs in with it, once. `expiresAt` is ISO. */
export type InvitationRecord = {
  id: string;
  orgId: string;
  role: OrganizationRole;
  emailHint: string | null;
  expiresAt: string;
};
/** Where an invitation stands at `now`: open, used, withdrawn, or past its time. */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
/** What the person holding a link sees before accepting: the organization it opens, the role, and
 *  whether it can still be used — `member` when they already belong, `acceptedByYou` when the link
 *  is the one they joined by (accepting it again re-lands the membership's facts). */
export type InvitationPreview = InvitationRecord & {
  orgName: string;
  status: InvitationStatus;
  member: boolean;
  acceptedByYou: boolean;
};
/** What a person can access: their organizations and every project of those, with their role. */
export type AccessibleRecord = { organizations: OrganizationRecord[]; projects: ProjectRecord[] };

export class ControlPlaneDatabase {
  private readonly sql: SqlStorageHandle;

  constructor(sql: SqlStorageHandle) {
    this.sql = sql;
    for (const statement of [
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)",
      "CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (provider, user_id))",
      "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (org_id, user_id))",
      "CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id)",
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id)",
      // An invitation link: the token's hash is the lookup (the token itself is never stored),
      // the id the owners' handle. Single use: `accepted_by` is set once. Times are epoch ms.
      "CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, role TEXT NOT NULL, email_hint TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, accepted_by TEXT, accepted_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS invitations_org ON invitations (org_id)",
      // THE CUSTOM HOSTNAMES — the edge's ingress routing table for hostnames a project added
      // (project/processor.ts claims and releases them): a hostname is ONE project's apex.
      "CREATE TABLE IF NOT EXISTS project_hostnames (hostname TEXT PRIMARY KEY, project_id TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS project_hostnames_project ON project_hostnames (project_id)",
    ])
      sql.exec(statement);
  }

  /** A query's rows, named by the query's own column aliases to match `T`. */
  #rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

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
  /** The first of `hostnames` a project holds, and that project — the edge's lookup for a host no
   *  static rule names, over iterate/project-ingress `customHostnameCandidatesOf` in its order. */
  projectByHostname(
    hostnames: readonly string[],
  ): { hostname: string; project: ProjectRecord } | null {
    for (const hostname of hostnames) {
      const project = this.#rows<ProjectRecord>(
        "SELECT p.id, p.slug, p.org_id AS orgId FROM project_hostnames h JOIN projects p ON p.id = h.project_id WHERE h.hostname = ?",
        hostname,
      )[0];
      if (project) return { hostname, project };
    }
    return null;
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

  /** Find-or-create the person for an email. */
  createUser(input: { email: string }): UserRecord {
    const email = emailAddress(input.email);
    return this.user(email) ?? this.#insertUser(newId("user"), email);
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

  /** A new organization, the caller its owner. The operator may name another owner, or none (the
   *  deployment's own). */
  createOrganization(
    caller: Caller,
    input: { name: string; ownerId?: string },
  ): OrganizationRecord {
    if (input.ownerId) this.#requireOperator(caller, "name an organization's owner");
    // named by id or email; the membership holds the id
    const owner = input.ownerId ? this.user(input.ownerId) : null;
    if (input.ownerId && !owner)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.ownerId)} to own it.`);
    const ownerId =
      owner?.id ??
      (isOperator(caller) ? null : this.#requireUser(caller, "create an organization"));
    const organizationId = newId("org");
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
    this.sql.exec("DELETE FROM invitations WHERE org_id = ?", organizationId);
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

  /** A new invitation link to an organization the caller owns: `tokenHash` is the SHA-256 of the
   *  secret the link carries (session.ts `mintInvitationToken`), `expiresAt` epoch ms. */
  createInvitation(
    caller: Caller,
    organizationId: string,
    input: { tokenHash: string; role: OrganizationRole; emailHint?: string; expiresAt: number },
    now: number,
  ): InvitationRecord {
    this.#requireOwner(caller, organizationId, "invite people to");
    if (input.expiresAt <= now)
      throw codedError("INVALID_INPUT", "An invitation expires in the future.");
    const id = newId("inv");
    this.sql.exec(
      "INSERT INTO invitations (id, token_hash, org_id, role, email_hint, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.tokenHash,
      organizationId,
      input.role,
      input.emailHint || null,
      caller.principal!.actor,
      now,
      input.expiresAt,
    );
    return this.#invitationById(id)!.record;
  }

  /** Withdraw an invitation of an organization the caller owns; again is a no-op. One already
   *  accepted is a membership now — removed as one, not revoked. */
  revokeInvitation(
    caller: Caller,
    organizationId: string,
    invitationId: string,
    now: number,
  ): InvitationRecord {
    this.#requireOwner(caller, organizationId, "revoke an invitation to");
    const found = this.#invitationById(invitationId);
    if (!found || found.record.orgId !== organizationId)
      throw codedError("INVALID_INPUT", "No such invitation to this organization.");
    if (found.acceptedBy)
      throw codedError(
        "INVALID_INPUT",
        "This invitation was already accepted; remove the member instead.",
      );
    if (found.revokedAt === null)
      this.sql.exec("UPDATE invitations SET revoked_at = ? WHERE id = ?", now, invitationId);
    return found.record;
  }

  /** What a link opens, for the person holding it — null for a token no invitation hashes to (or
   *  whose organization is gone). `userId` is the reader, for `member`. */
  invitation(tokenHash: string, userId: string | null, now: number): InvitationPreview | null {
    const found = this.#invitationByToken(tokenHash);
    const organization = found && this.organization(found.record.orgId);
    if (!found || !organization) return null;
    return {
      ...found.record,
      orgName: organization.name,
      status: invitationStatus(found, now),
      member: Boolean(userId && this.#role(found.record.orgId, userId)),
      acceptedByYou: Boolean(userId && found.acceptedBy === userId),
    };
  }

  /** The caller joins the organization a link opens, in its role. SINGLE USE: the first person to
   *  accept consumes it; that same person again is answered the same while they still belong,
   *  anyone else is refused, as is a revoked or expired link. A person who already belongs keeps
   *  their role and leaves the link unused — it was meant for someone else (`accepted: false`).
   *  `role` is the membership as it stands now (a later promotion included), so the session can
   *  land the facts again on a retry without rewinding it. */
  acceptInvitation(
    caller: Caller,
    tokenHash: string,
    now: number,
  ): { invitation: InvitationRecord; userId: string; role: OrganizationRole; accepted: boolean } {
    const userId = this.#requireUser(caller, "accept an invitation");
    const found = this.#invitationByToken(tokenHash);
    if (!found || !this.organization(found.record.orgId))
      throw codedError("INVALID_INPUT", "This invitation link is not valid.");
    const { orgId } = found.record;
    const role = this.#role(orgId, userId);
    // the same person again, still a member: the answer they had (removed since, the link is spent)
    if (found.acceptedBy === userId && role)
      return { invitation: found.record, userId, role, accepted: true };
    const status = invitationStatus(found, now);
    if (status !== "pending")
      throw codedError(
        "INVALID_INPUT",
        status === "accepted"
          ? "This invitation was already used by someone else."
          : status === "revoked"
            ? "This invitation was revoked."
            : "This invitation has expired.",
      );
    if (role) return { invitation: found.record, userId, role, accepted: false };
    this.#insertMembership(orgId, userId, found.record.role);
    this.sql.exec(
      "UPDATE invitations SET accepted_by = ?, accepted_at = ? WHERE id = ?",
      userId,
      now,
      found.record.id,
    );
    return { invitation: found.record, userId, role: found.record.role, accepted: true };
  }

  #invitationById(invitationId: string) {
    return this.#invitationWhere("id = ?", invitationId);
  }
  #invitationByToken(tokenHash: string) {
    return this.#invitationWhere("token_hash = ?", tokenHash);
  }
  #invitationWhere(where: string, binding: string): InvitationRow | null {
    const row = this.#rows<{
      id: string;
      orgId: string;
      role: OrganizationRole;
      emailHint: string | null;
      expiresAt: number;
      revokedAt: number | null;
      acceptedBy: string | null;
    }>(
      `SELECT id, org_id AS orgId, role, email_hint AS emailHint, expires_at AS expiresAt, revoked_at AS revokedAt, accepted_by AS acceptedBy FROM invitations WHERE ${where}`,
      binding,
    )[0];
    if (!row) return null;
    const { revokedAt, acceptedBy, expiresAt, ...rest } = row;
    return {
      record: { ...rest, expiresAt: new Date(expiresAt).toISOString() },
      expiresAtMs: expiresAt,
      revokedAt,
      acceptedBy,
    };
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

  /** Claim `hostname` for a project: again for the same project is a no-op. Refused when another
   *  project holds it or any name above it — a project's hostname is a wildcard (its apps are the
   *  names under it, and `*.<hostname>` points at us), so a name under it is that project's.
   *  The project processor claims before it provisions (project/processor.ts). */
  claimHostname(projectId: string, hostname: string): void {
    if (!this.project(projectId))
      throw codedError("INVALID_INPUT", `No project ${JSON.stringify(projectId)}.`);
    const labels = hostname.split(".");
    const selfAndAbove = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
    const holders = this.#rows<{ hostname: string; projectId: string }>(
      `SELECT hostname, project_id AS projectId FROM project_hostnames WHERE hostname IN (${selfAndAbove.map(() => "?").join(", ")})`,
      ...selfAndAbove,
    );
    const foreign = holders.find((holder) => holder.projectId !== projectId);
    if (foreign)
      throw codedError(
        "INVALID_INPUT",
        foreign.hostname === hostname
          ? `The hostname '${hostname}' belongs to another project.`
          : `'${hostname}' is under '${foreign.hostname}', which belongs to another project.`,
      );
    if (!holders.some((holder) => holder.hostname === hostname))
      this.sql.exec(
        "INSERT INTO project_hostnames (hostname, project_id) VALUES (?, ?)",
        hostname,
        projectId,
      );
  }
  /** Release a project's claim on `hostname`; another project's claim, or none, is left alone. */
  releaseHostname(projectId: string, hostname: string): void {
    this.sql.exec(
      "DELETE FROM project_hostnames WHERE hostname = ? AND project_id = ?",
      hostname,
      projectId,
    );
  }

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

type InvitationRow = {
  record: InvitationRecord;
  expiresAtMs: number;
  revokedAt: number | null;
  acceptedBy: string | null;
};

/** Used beats withdrawn beats expired: an accepted link stays accepted whatever its clock says. */
function invitationStatus(row: InvitationRow, now: number): InvitationStatus {
  if (row.acceptedBy) return "accepted";
  if (row.revokedAt !== null) return "revoked";
  return row.expiresAtMs <= now ? "expired" : "pending";
}
