// src/control-plane/catalog.ts — THE CONTROL PLANE DATABASE: every user, identity, organization,
// membership, project, invitation and custom hostname of the deployment, as tables in its D1
// (db/definitions.sql), each read and write a named query (db/queries/*.sql). EVERY WRITE IS ONE
// STATEMENT OR ONE BATCH WITH ITS GUARD IN ITS SQL (db/index.ts says why): a constraint, `on
// conflict`, or a `where` that a caller the write must refuse no longer passes (an owner demoted a
// moment ago, a link someone else just used). Why a write was refused is read back later in the same
// batch, never decided by a read before it. The clock comes in as `now` (epoch ms), and an
// invitation's token already hashed (session.ts mints and hashes it).
import { codedError } from "iterate/lib";
import { createD1Client, SqlfuError } from "sqlfu";
import type { Caller as PrincipalCaller } from "../caller.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import type { IdentityProvider } from "./contract.ts";
import { batch } from "./db/index.ts";
import {
  claimHostname,
  clearPrimaryHostname,
  primaryHostnameOf,
  projectsByHostnames,
  releaseHostname,
  setPrimaryHostname,
} from "./db/queries/.generated/hostnames.sql.ts";
import {
  integrationRoute,
  moveIntegrationRoute,
  releaseIntegrationRoute,
  releaseIntegrationRoutes,
  releaseOtherIntegrationRoutes,
  releaseRoutesOfDeletedProject,
  routeIntegration,
} from "./db/queries/.generated/integration-routes.sql.ts";
import {
  acceptInvitation,
  insertAcceptedMembership,
  insertInvitation,
  invitationById,
  invitationByToken,
  revokeInvitation,
} from "./db/queries/.generated/invitations.sql.ts";
import {
  accessibleOrganizations,
  accessibleProjects,
  deleteMembership,
  deleteOrganization,
  insertOrganization,
  insertOwner,
  listMembers,
  listOrganizations,
  memberOf,
  organizationById,
  organizationRole,
  renameOrganization,
  upsertMembership,
} from "./db/queries/.generated/organizations.sql.ts";
import {
  deleteProject,
  firstOrganizationOf,
  insertAdminOrganization,
  insertFirstOrganizationProject,
  insertMemberProject,
  insertPersonalOrganization,
  insertProject,
  listProjects,
  projectsByRef,
} from "./db/queries/.generated/projects.sql.ts";
import {
  identityUser,
  insertIdentity,
  insertUserIfNew,
  insertUserUnlessLinked,
  listUsers,
  updateUserEmail,
  userByRef,
} from "./db/queries/.generated/users.sql.ts";

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

const newId = (prefix: "user" | "org" | "prj" | "inv" | "acc") =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export type UserRecord = { id: string; email: string };
/** A project, addressed by `id` everywhere (the context's name, a grant's list, the API); `slug` is
 *  the DNS label of its hostnames; `role` is the reader's, when read through their memberships. A
 *  row is inserted once and never updated, and its copies rely on that: the edge's memo (edge.ts)
 *  and a context's own `project-slug` (iterate-context-durable-object.ts `#projectSlug`) — a slug
 *  that could change must reach them. */
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
/** Where the platform's own app routes a provider account's webhooks: the connection's log, `path`
 *  in `projectId`. */
export type IntegrationRouteRecord = { projectId: string; path: string };
/** What a person can access: their organizations and every project of those, with their role. */
export type AccessibleRecord = { organizations: OrganizationRecord[]; projects: ProjectRecord[] };

export class ControlPlaneDatabase {
  readonly #d1: D1Database;
  readonly #client: ReturnType<typeof createD1Client>;

  constructor(d1: D1Database) {
    this.#d1 = d1;
    this.#client = createD1Client(d1);
  }

  /** A user by id or by email. */
  user(ref: string): Promise<UserRecord | null> {
    return userByRef(this.#client, { id: ref, email: emailAddress(ref) });
  }
  users(): Promise<UserRecord[]> {
    return listUsers(this.#client);
  }
  /** The user a provider's subject names. */
  async identity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    const user = await identityUser(this.#client, { provider, subject });
    return user && { id: user.id, email: user.email };
  }
  organization(organizationId: string): Promise<OrganizationRecord | null> {
    return organizationById(this.#client, { id: organizationId });
  }
  organizations(): Promise<OrganizationRecord[]> {
    return listOrganizations(this.#client);
  }
  members(organizationId: string): Promise<MemberRecord[]> {
    return listMembers(this.#client, { orgId: organizationId });
  }
  /** A project by id or by slug (a slug never holds the `_` every id does, so at most one row). */
  async project(ref: string): Promise<ProjectRecord | null> {
    return (await projectsByRef(this.#client, { id: ref, slug: ref }))[0] ?? null;
  }
  projects(): Promise<ProjectRecord[]> {
    return listProjects(this.#client);
  }
  /** The first of `hostnames` a project holds, and that project — the edge's lookup for a host no
   *  static rule names, over iterate/project-ingress `customHostnameCandidatesOf` in its order. */
  async projectByHostname(
    hostnames: readonly string[],
  ): Promise<{ hostname: string; project: ProjectRecord } | null> {
    const held = await projectsByHostnames(this.#client, { hostnames: [...hostnames] });
    for (const hostname of hostnames) {
      const row = held.find((candidate) => candidate.hostname === hostname);
      if (row) return { hostname, project: { id: row.id, slug: row.slug, orgId: row.orgId } };
    }
    return null;
  }
  /** The connection a provider account's webhooks go to (`routeIntegration`), or null. */
  async integrationRoute(
    provider: string,
    externalId: string,
  ): Promise<IntegrationRouteRecord | null> {
    return integrationRoute(this.#client, { provider, externalId });
  }
  /** What a person can access: the organizations they belong to — the first by name is where a
   *  project goes when none is named — and every project of those, with their role. One batch, so
   *  the two lists are one moment's. */
  async accessibleTo(userId: string): Promise<AccessibleRecord> {
    const results = await batch(this.#d1, [
      accessibleOrganizations.query({ userId }),
      accessibleProjects.query({ userId }),
    ]);
    return {
      organizations: rowsOf<accessibleOrganizations.Result>(results, 0),
      projects: rowsOf<accessibleProjects.Result>(results, 1),
    };
  }
  /** What a link opens, for the person holding it — null for a token no invitation hashes to (an
   *  organization's deletion takes its invitations). `userId` is the reader, for `member`. */
  async invitation(
    tokenHash: string,
    userId: string | null,
    now: number,
  ): Promise<InvitationPreview | null> {
    // nobody signed in is nobody's role: no user has the empty id
    const found = await invitationByToken(this.#client, { tokenHash, userId: userId || "" });
    if (!found) return null;
    return {
      ...invitationRecord(found),
      orgName: found.orgName,
      status: invitationStatus(found, now),
      member: Boolean(found.memberRole),
      acceptedByYou: Boolean(userId && found.acceptedBy === userId),
    };
  }

  // ── the writes: each ONE statement or ONE batch, its guard in its SQL ──

  /** Find-or-create the person for an email: the insert does nothing for an email already held. */
  async createUser(input: { email: string }): Promise<UserRecord> {
    const email = emailAddress(input.email);
    const results = await batch(this.#d1, [
      insertUserIfNew.query({ id: newId("user"), email }),
      userByRef.query({ id: email, email }),
    ]);
    return rowsOf<userByRef.Result>(results, 1)[0]!;
  }

  /** A verified sign-in: link once by verified email, then resolve by the provider's stable
   *  subject. A linked subject's changed email follows it when it is the person's only sign-in,
   *  unless another person holds that email;
   *  a second subject of the same provider cannot adopt an already-linked person. Takes no caller —
   *  it is the sign-in system linking a verified identity, never a person's own command.
   *
   *  One batch links: a person for the email unless the subject is linked already, then the
   *  identity, which the key (provider, subject) keeps to one and `unique (provider, user_id)`
   *  refuses for a person another subject of the provider links — so two first sign-ins at once
   *  resolve to one person, and a refused link reads back as no one. */
  async linkIdentity(input: {
    provider: IdentityProvider;
    subject: string;
    email: string;
  }): Promise<UserRecord> {
    const { provider, subject } = input;
    const email = emailAddress(input.email);
    const results = await batch(this.#d1, [
      insertUserUnlessLinked.query({ id: newId("user"), email, provider, subject }),
      insertIdentity.query({ provider, subject, email }),
      identityUser.query({ provider, subject }),
    ]);
    const linked = rowsOf<identityUser.RawResult>(results, 2)[0];
    if (!linked)
      throw codedError("IDENTITY_CONFLICT", "This email belongs to another linked account.");
    // The email follows a person's only sign-in. With more than one (Google and GitHub, say), each
    // provider may report its own address, and none of them rewrites the person's.
    if (linked.email === email || (linked.sign_ins ?? 1) > 1)
      return { id: linked.id, email: linked.email };
    try {
      await updateUserEmail(this.#client, { email }, { id: linked.id });
    } catch (error) {
      if (error instanceof SqlfuError && error.kind === "unique_violation")
        throw codedError("IDENTITY_CONFLICT", "This email belongs to another account.");
      throw error;
    }
    return { id: linked.id, email };
  }

  /** A new organization, the caller its owner. The operator may name another owner, or none (the
   *  deployment's own). The organization and its owner land in one batch. */
  async createOrganization(
    caller: Caller,
    input: { name: string; ownerId?: string },
  ): Promise<OrganizationRecord> {
    if (input.ownerId) this.#requireOperator(caller, "name an organization's owner");
    // named by id or email; the membership holds the id (a user is never deleted)
    const owner = input.ownerId ? await this.user(input.ownerId) : null;
    if (input.ownerId && !owner)
      throw codedError("INVALID_INPUT", `No user ${JSON.stringify(input.ownerId)} to own it.`);
    const ownerId =
      owner?.id ??
      (isOperator(caller) ? null : this.#requireUser(caller, "create an organization"));
    const organization = { id: newId("org"), name: input.name.trim() };
    await batch(this.#d1, [
      insertOrganization.query(organization),
      ...(ownerId ? [insertOwner.query({ userId: ownerId, orgId: organization.id })] : []),
    ]);
    const record: OrganizationRecord = { ...organization, projects: 0 };
    if (ownerId && ownerId === caller.principal?.actor) record.role = "owner";
    return record;
  }

  async renameOrganization(
    caller: Caller,
    organizationId: string,
    name: string,
  ): Promise<OrganizationRecord> {
    const guard = this.#ownerGuard(caller, "rename");
    const results = await batch(this.#d1, [
      renameOrganization.query({ name: name.trim() }, { id: organizationId, ...guard }),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
    ]);
    const organization = rowsOf<organizationRole.Result>(results, 1)[0];
    if (!changed(results[0]))
      throw (
        ownerRefusal(organization, guard, "rename") ??
        new Error(`renameOrganization changed nothing for its owner (${organizationId})`)
      );
    return { id: organizationId, name: name.trim(), projects: organization!.projects };
  }

  /** Delete an organization — only while it holds no project; its memberships and invitations go
   *  with it (the foreign keys cascade). */
  async deleteOrganization(caller: Caller, organizationId: string): Promise<void> {
    const guard = this.#ownerGuard(caller, "delete");
    const results = await batch(this.#d1, [
      deleteOrganization.query({ id: organizationId, ...guard }),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
    ]);
    if (changed(results[0])) return;
    const organization = rowsOf<organizationRole.Result>(results, 1)[0];
    const refusal = ownerRefusal(organization, guard, "delete");
    if (refusal) throw refusal;
    const { projects } = organization!;
    throw codedError(
      "INVALID_INPUT",
      `This organization still holds ${projects} project${projects === 1 ? "" : "s"}.`,
    );
  }

  /** Add a person, named by id or email, or change their role; answers the id the membership
   *  holds. The last owner stays: the upsert's own `where` refuses to demote them. */
  async addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<string> {
    const guard = this.#ownerGuard(caller, "add a member to");
    const person = {
      orgId: organizationId,
      userId: input.userId,
      email: emailAddress(input.userId),
    };
    const results = await batch(this.#d1, [
      upsertMembership.query({ ...person, role: input.role, ...guard }),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
      memberOf.query(person),
    ]);
    const member = rowsOf<memberOf.Result>(results, 2)[0];
    if (changed(results[0])) return member!.id;
    throw (
      ownerRefusal(rowsOf<organizationRole.Result>(results, 1)[0], guard, "add a member to") ??
      (member
        ? codedError("INVALID_INPUT", "An organization keeps at least one owner.")
        : codedError("INVALID_INPUT", `No user ${JSON.stringify(input.userId)} to add.`))
    );
  }

  /** Remove a person, named by id or email; the last owner stays. Answers the id removed. */
  async removeMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string },
  ): Promise<string> {
    const guard = this.#ownerGuard(caller, "remove a member from");
    const person = {
      orgId: organizationId,
      userId: input.userId,
      email: emailAddress(input.userId),
    };
    const results = await batch(this.#d1, [
      deleteMembership.query({ ...person, ...guard }),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
      memberOf.query(person),
    ]);
    const member = rowsOf<memberOf.Result>(results, 2)[0];
    if (changed(results[0])) return member!.id;
    throw (
      ownerRefusal(rowsOf<organizationRole.Result>(results, 1)[0], guard, "remove a member from") ??
      (member?.role
        ? codedError("INVALID_INPUT", "An organization keeps at least one owner.")
        : codedError("INVALID_INPUT", "Not a member of that organization."))
    );
  }

  /** A new invitation link to an organization the caller owns: `tokenHash` is the SHA-256 of the
   *  secret the link carries (session.ts `mintInvitationToken`), `expiresAt` epoch ms. */
  async createInvitation(
    caller: Caller,
    organizationId: string,
    input: { tokenHash: string; role: OrganizationRole; emailHint?: string; expiresAt: number },
    now: number,
  ): Promise<InvitationRecord> {
    const guard = this.#ownerGuard(caller, "invite people to");
    if (input.expiresAt <= now)
      throw codedError("INVALID_INPUT", "An invitation expires in the future.");
    const invitation = {
      id: newId("inv"),
      orgId: organizationId,
      role: input.role,
      // D1 binds null, never undefined (D1_TYPE_ERROR)
      emailHint: input.emailHint || null,
      expiresAt: input.expiresAt,
    };
    const results = await batch(this.#d1, [
      insertInvitation.query({
        ...invitation,
        tokenHash: input.tokenHash,
        createdBy: caller.principal!.actor,
        createdAt: now,
        ...guard,
      }),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
    ]);
    if (!changed(results[0]))
      throw (
        ownerRefusal(rowsOf<organizationRole.Result>(results, 1)[0], guard, "invite people to") ??
        new Error(`createInvitation changed nothing for its owner (${organizationId})`)
      );
    return invitationRecord(invitation);
  }

  /** Withdraw an invitation of an organization the caller owns; again is a no-op. One already
   *  accepted is a membership now — removed as one, not revoked. The revoke's own `where` leaves an
   *  accepted or revoked link alone, so an accept and a revoke at once end as one of the two. */
  async revokeInvitation(
    caller: Caller,
    organizationId: string,
    invitationId: string,
    now: number,
  ): Promise<InvitationRecord> {
    const guard = this.#ownerGuard(caller, "revoke an invitation to");
    const results = await batch(this.#d1, [
      revokeInvitation.query(
        { revokedAt: now },
        { id: invitationId, orgId: organizationId, ...guard },
      ),
      organizationRole.query({ orgId: organizationId, userId: guard.actorId }),
      invitationById.query({ id: invitationId }),
    ]);
    const found = rowsOf<invitationById.Result>(results, 2)[0];
    if (changed(results[0])) return invitationRecord(found!);
    const refusal = ownerRefusal(
      rowsOf<organizationRole.Result>(results, 1)[0],
      guard,
      "revoke an invitation to",
    );
    if (refusal) throw refusal;
    if (!found || found.orgId !== organizationId)
      throw codedError("INVALID_INPUT", "No such invitation to this organization.");
    if (found.acceptedBy)
      throw codedError(
        "INVALID_INPUT",
        "This invitation was already accepted; remove the member instead.",
      );
    return invitationRecord(found);
  }

  /** The caller joins the organization a link opens, in its role. SINGLE USE: the first person to
   *  accept consumes it; that same person again is answered the same while they still belong,
   *  anyone else is refused, as is a revoked or expired link. A person who already belongs keeps
   *  their role and leaves the link unused — it was meant for someone else (`accepted: false`).
   *  `role` is the membership as it stands now (a later promotion included), so the session can
   *  land the facts again on a retry without rewinding it.
   *
   *  One batch: the link is marked accepted, under this request's own `acceptance_id`, only while it
   *  is open and the caller no member; then the membership that acceptance feeds; then the link as it
   *  stands. So of N people accepting at once exactly one joins, and a retry adds no one: its own id
   *  marked nothing. (A trigger on the update would add it in one statement, but D1's remote
   *  `/query` splitter misreads a trigger body opened with a lowercase `begin`, which every local
   *  path accepts: https://github.com/cloudflare/workers-sdk/issues/15314.) */
  async acceptInvitation(
    caller: Caller,
    tokenHash: string,
    now: number,
  ): Promise<{
    invitation: InvitationRecord;
    userId: string;
    role: OrganizationRole;
    accepted: boolean;
  }> {
    const userId = this.#requireUser(caller, "accept an invitation");
    const acceptanceId = newId("acc");
    const results = await batch(this.#d1, [
      acceptInvitation.query(
        { acceptedBy: userId, acceptedAt: now, acceptanceId },
        { tokenHash, now, userId },
      ),
      insertAcceptedMembership.query({ tokenHash, acceptanceId }),
      invitationByToken.query({ tokenHash, userId }),
    ]);
    const found = rowsOf<invitationByToken.Result>(results, 2)[0];
    if (!found) throw codedError("INVALID_INPUT", "This invitation link is not valid.");
    const invitation = invitationRecord(found);
    if (changed(results[0])) return { invitation, userId, role: found.role, accepted: true };
    // the same person again, still a member: the answer they had (removed since, the link is spent)
    if (found.acceptedBy === userId && found.memberRole)
      return { invitation, userId, role: found.memberRole, accepted: true };
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
    if (found.memberRole) return { invitation, userId, role: found.memberRole, accepted: false };
    throw new Error(`acceptInvitation changed nothing for an open link (${found.id})`);
  }

  /** A project named `project` (slugified into its hostname label): in the organization named (a
   *  member's, or any for the operator) or the caller's own — their first by name, made on first use
   *  and named after their email's local part (the deployment's own for the operator). A slug is ONE
   *  project across every organization: the same organization's again is the same project, another's
   *  is PROJECT_NAME_TAKEN, and nothing is made. The project's own creation (its config repo, its
   *  seed) is its root's saga, opened by the caller (session.ts) after this returns.
   *
   *  Each case is one batch whose inserts do nothing on a taken slug or id (`on conflict do
   *  nothing`, or a `where` that finds it taken) and whose last reads say what holds the slug and
   *  the id now, and which organization was the target (`created` decides). A person with no
   *  organization is the one case that takes two: the first finds none and reads their email, and
   *  the second mints their own, named after it (sqlfu 0.1.1 types no `substr`, so the name is cut
   *  here, not in SQL) — only while they still belong nowhere and the slug is free, so two first
   *  creations at once make one. */
  async createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ): Promise<ProjectRecord> {
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
    const project = { id: restoring || newId("prj"), slug };

    if (input.organizationId) {
      const orgId = input.organizationId;
      const results = await batch(this.#d1, [
        userId
          ? insertMemberProject.query({ ...project, orgId, userId })
          : insertProject.query({ ...project, orgId }),
        organizationRole.query({ orgId, userId: caller.principal!.actor }),
        projectsByRef.query(project),
      ]);
      const organization = rowsOf<organizationRole.Result>(results, 1)[0];
      if (!organization || (userId && !organization.role))
        throw codedError("FORBIDDEN", "You cannot create a project in that organization.");
      return created(rowsOf<projectsByRef.Result>(results, 2), project, orgId, restoring);
    }
    if (!userId) {
      const results = await batch(this.#d1, [
        insertAdminOrganization.query({ orgId: ADMIN_ORG_ID, slug, projectId: project.id }),
        insertProject.query({ ...project, orgId: ADMIN_ORG_ID }),
        projectsByRef.query(project),
      ]);
      return created(rowsOf<projectsByRef.Result>(results, 2), project, ADMIN_ORG_ID, restoring);
    }
    const first = await batch(this.#d1, [
      insertFirstOrganizationProject.query({ ...project, userId }),
      firstOrganizationOf.query({ userId }),
      projectsByRef.query(project),
      userByRef.query({ id: userId, email: userId }),
    ]);
    const target = rowsOf<firstOrganizationOf.Result>(first, 1)[0];
    const held = rowsOf<projectsByRef.Result>(first, 2);
    const user = rowsOf<userByRef.Result>(first, 3)[0];
    if (target || held.length || !user) return created(held, project, target?.id, restoring);
    const orgId = newId("org");
    const minted = await batch(this.#d1, [
      insertPersonalOrganization.query({
        id: orgId,
        name: user.email.split("@")[0]!,
        userId,
        slug,
      }),
      insertOwner.query({ userId, orgId }),
      insertFirstOrganizationProject.query({ ...project, userId }),
      firstOrganizationOf.query({ userId }),
      projectsByRef.query(project),
    ]);
    return created(
      rowsOf<projectsByRef.Result>(minted, 4),
      project,
      rowsOf<firstOrganizationOf.Result>(minted, 3)[0]?.id,
      restoring,
    );
  }

  /** The project `caller` may delete — the owner of its organization, or the operator — or a
   *  refusal. Asked before the deletion is requested, so nothing is asked for that the row's delete
   *  would then refuse; `deleteProject`'s statement checks again as it deletes. */
  async projectToDelete(caller: Caller, ref: string): Promise<ProjectRecord> {
    const guard = this.#ownerGuard(caller, "delete a project of");
    const project = await this.project(ref);
    if (!project) throw codedError("FORBIDDEN", "You cannot delete that project.");
    if (guard.asOperator) return project;
    const organization = await organizationRole(this.#client, {
      orgId: project.orgId,
      userId: guard.actorId,
    });
    const refusal = ownerRefusal(organization || undefined, guard, "delete a project of");
    if (refusal) throw refusal;
    return project;
  }

  /** Delete a project's row: the statement's own `where` lets only the organization's owner, or the
   *  operator, delete it. Nothing reaches the project once its row is gone; its data is the deletion
   *  saga's (project/processor.ts), and so are its hostname claims, which are no foreign key: the
   *  saga removes each custom hostname at Cloudflare, then releases the claim, so no other project
   *  takes the name while Cloudflare still serves it. Answers the row deleted. */
  async deleteProject(caller: Caller, ref: string): Promise<ProjectRecord> {
    const project = await this.projectToDelete(caller, ref);
    const guard = this.#ownerGuard(caller, "delete a project of");
    const results = await batch(this.#d1, [
      deleteProject.query({ id: project.id, ...guard }),
      organizationRole.query({ orgId: project.orgId, userId: guard.actorId }),
      // its connections' webhook routes go with it, or an account it held could never be routed
      // to another project (`routeIntegration`: first owner wins)
      releaseRoutesOfDeletedProject.query({ projectId: project.id }),
    ]);
    if (changed(results[0])) return project;
    throw (
      ownerRefusal(rowsOf<organizationRole.Result>(results, 1)[0], guard, "delete a project of") ??
      codedError("FORBIDDEN", "You cannot delete that project.")
    );
  }

  /** Claim `hostname` for a project: again for the same project is a no-op. Refused when another
   *  project holds it or any name above it — a project's hostname is a wildcard (its apps are the
   *  names under it, and `*.<hostname>` points at us), so a name under it is that project's. The
   *  insert's own `where` refuses it, so two nested claims at once end as one of the two orders.
   *  The project processor claims before it provisions (project/processor.ts). */
  async claimHostname(projectId: string, hostname: string): Promise<void> {
    const labels = hostname.split(".");
    const selfAndAbove = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
    const results = await batch(this.#d1, [
      claimHostname.query({ hostname, projectId, selfAndAbove }),
      projectsByHostnames.query({ hostnames: selfAndAbove }),
    ]);
    const holders = rowsOf<projectsByHostnames.Result>(results, 1);
    if (holders.some((holder) => holder.hostname === hostname && holder.id === projectId)) return;
    const foreign = holders.find((holder) => holder.id !== projectId);
    if (!foreign) throw codedError("INVALID_INPUT", `No project ${JSON.stringify(projectId)}.`);
    throw codedError(
      "INVALID_INPUT",
      foreign.hostname === hostname
        ? `The hostname '${hostname}' belongs to another project.`
        : `'${hostname}' is under '${foreign.hostname}', which belongs to another project.`,
    );
  }
  /** Release a project's claim on `hostname`; another project's claim, or none, is left alone. */
  async releaseHostname(projectId: string, hostname: string): Promise<void> {
    await releaseHostname(this.#client, { hostname, projectId });
  }

  /** Route `externalId` at `provider` to the connection at `path`: FIRST OWNER WINS — again for the
   *  same connection is a no-op, and a route another connection holds is refused (its holder
   *  disconnects first). The connection's route to any other account goes: one account each. One
   *  batch, the guards in its statements: the insert only for a project that exists and an account
   *  nobody holds, the release of the connection's other routes only once it holds this one. */
  async routeIntegration(
    provider: string,
    externalId: string,
    projectId: string,
    path: string,
  ): Promise<void> {
    const route = { provider, externalId, projectId, path };
    const results = await batch(this.#d1, [
      routeIntegration.query(route),
      releaseOtherIntegrationRoutes.query(route),
      integrationRoute.query({ provider, externalId }),
    ]);
    const holder = rowsOf<integrationRoute.Result>(results, 2)[0];
    if (holder?.projectId === projectId && holder.path === path) return;
    if (!holder) throw codedError("INVALID_INPUT", `No project ${JSON.stringify(projectId)}.`);
    throw codedError(
      "INVALID_INPUT",
      holder.projectId === projectId
        ? `The ${provider} account '${externalId}' is already connected at ${holder.path}.`
        : `The ${provider} account '${externalId}' is connected to another project.`,
    );
  }
  /** MOVE a provider account's route from the connection that holds it (`from`) to another (`to`):
   *  one batch — the route re-pointed ONLY while `from` still holds this account (a compare-and-swap
   *  on the row), then `to`'s other routes released only once `to` holds it. So the account is never
   *  routed to both or neither, and when `from` no longer holds it (it gave it up, or moved it
   *  meanwhile) the batch changes nothing and the move is refused. */
  async moveIntegrationRoute(
    provider: string,
    externalId: string,
    from: { projectId: string; path: string },
    to: { projectId: string; path: string },
  ): Promise<void> {
    const route = { provider, externalId, ...to };
    const results = await batch(this.#d1, [
      moveIntegrationRoute.query(
        { toProjectId: to.projectId, toPath: to.path },
        { provider, externalId, fromProjectId: from.projectId, fromPath: from.path },
      ),
      releaseOtherIntegrationRoutes.query(route),
      integrationRoute.query({ provider, externalId }),
    ]);
    const holder = rowsOf<integrationRoute.Result>(results, 2)[0];
    if (holder?.projectId === to.projectId && holder.path === to.path) return;
    throw codedError(
      "INVALID_INPUT",
      `The ${provider} account '${externalId}' moved meanwhile — connect it again.`,
    );
  }
  /** Release ONE account's route, only while the connection at `path` holds it: a connection that
   *  took another account since keeps that one's. */
  async releaseIntegrationRoute(
    provider: string,
    externalId: string,
    projectId: string,
    path: string,
  ): Promise<void> {
    await releaseIntegrationRoute(this.#client, { provider, externalId, projectId, path });
  }
  /** Release every route of the connection at `path` in a project; another's are left alone. */
  async releaseIntegrationRoutes(projectId: string, path: string): Promise<void> {
    await releaseIntegrationRoutes(this.#client, { projectId, path });
  }

  /** Set a project's primary hostname, or clear it with null. */
  async setPrimaryHostname(projectId: string, hostname: string | null): Promise<void> {
    await (hostname
      ? setPrimaryHostname(this.#client, { projectId, hostname })
      : clearPrimaryHostname(this.#client, { projectId }));
  }
  /** A project's primary hostname, while the project still holds its claim; null for none. */
  async primaryHostnameOf(projectId: string): Promise<string | null> {
    return (await primaryHostnameOf(this.#client, { projectId }))?.hostname ?? null;
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
  /** The owner guard an owner-only verb's statement carries (`:asOperator = 1 or exists (… owner
   *  … :actorId)`): the operator passes it, a person only while they own the organization, checked
   *  by the statement as it writes. */
  #ownerGuard(caller: Caller, verb: string) {
    if (isOperator(caller)) return { asOperator: 1, actorId: caller.principal!.actor };
    return { asOperator: 0, actorId: this.#requireUser(caller, `${verb} an organization`) };
  }
}

/** Statement `index`'s rows of a batch, as its query's generated `Result`: a row is keyed by the
 *  SQL's own column aliases, which the queries spell as that `Result`'s keys (db/index.ts). */
const rowsOf = <T>(results: D1Result[], index: number) => results[index]!.results as T[];

/** Whether a write of a batch changed a row: its guard let it through. */
const changed = (result: D1Result | undefined) => Boolean(result?.meta.changes);

/** Why an owner-only write its guard stopped was refused, when it was the organization or the
 *  caller — gone, or not (any longer) an owner — as the same batch read them after it. Undefined
 *  when neither: the verb's own refusal applies. */
function ownerRefusal(
  organization: organizationRole.Result | undefined,
  guard: { asOperator: number },
  verb: string,
) {
  if (!organization) return codedError("FORBIDDEN", `You cannot ${verb} that organization.`);
  if (!guard.asOperator && organization.role !== "owner")
    return codedError("FORBIDDEN", `Only an owner can ${verb} an organization.`);
  return undefined;
}

/** What a creation's batch read back decides, `held` being the rows that hold its slug or its id
 *  now and `target` the organization it went to: the slug's row in the target is the project, made
 *  now or before (a restore of the same archive again converges); in any other organization the
 *  name is taken; a restored id held under another slug is a conflict. */
function created(
  held: ProjectRecord[],
  wanted: { id: string; slug: string },
  target: string | undefined,
  restoring: string | undefined,
): ProjectRecord {
  const bySlug = held.find((row) => row.slug === wanted.slug);
  if (bySlug && bySlug.orgId !== target)
    throw codedError("PROJECT_NAME_TAKEN", `The project name '${wanted.slug}' is already taken.`);
  if (bySlug && restoring && bySlug.id !== restoring)
    throw codedError(
      "IDENTITY_CONFLICT",
      `The project '${wanted.slug}' exists with id ${bySlug.id}, not the restored id ${restoring}.`,
    );
  if (bySlug) return bySlug;
  const byId = held.find((row) => row.id === wanted.id);
  if (byId)
    throw codedError(
      "IDENTITY_CONFLICT",
      `The restored project id ${wanted.id} already belongs to '${byId.slug}'.`,
    );
  if (!target) throw codedError("FORBIDDEN", "A user session is required to create a project.");
  throw new Error(`createProject made nothing for '${wanted.slug}' in ${target}`);
}

/** An invitation row as its owners see it (`InvitationRecord`). */
function invitationRecord(row: {
  id: string;
  orgId: string;
  role: OrganizationRole;
  emailHint?: string | null;
  expiresAt: number;
}): InvitationRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    role: row.role,
    emailHint: row.emailHint || null,
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

/** Used beats withdrawn beats expired: an accepted link stays accepted whatever its clock says. */
function invitationStatus(
  row: { acceptedBy?: string; revokedAt?: number; expiresAt: number },
  now: number,
): InvitationStatus {
  if (row.acceptedBy) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt <= now ? "expired" : "pending";
}
