// __workers-tests__/control-plane-catalog.test.ts — the control-plane database's executable spec, over
// the D1 it runs on (miniflare's, foreign keys enforced, this file's own): every write, what it
// answers, what it refuses, read back off the tables — and the writes that must hold against a
// concurrent one, fired together: each is one statement or one batch with its guard in SQL
// (catalog.ts), so either order of two must leave the invariant standing. Delivery of the entity
// streams' activity and a project's own creation saga are the session's (session.ts), proven on the
// worker (control-plane.test.ts, e2e/organizations.e2e.test.ts).
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  ADMIN_ORG_ID,
  type Caller,
  ControlPlaneDatabase,
  projectSlug,
} from "../src/control-plane/catalog.ts";
import { listOAuthGrants } from "../src/control-plane/db/queries/.generated/oauth-grants.sql.ts";
import { OAuthGrantTable } from "../src/control-plane/oauth-grants.ts";

const admin: Caller = { principal: { actor: "admin" } };
const c = new ControlPlaneDatabase(env.DB);

test("people: find-or-create by email, one spelling of an address, one person when asked at once", async () => {
  await emptyTables();
  const ada = await c.createUser({ email: " Ada@Example.com " });
  expect(ada).toEqual({
    id: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "ada@example.com",
  });
  expect(await c.createUser({ email: "ADA@example.com" })).toEqual(ada);
  expect(await c.user("ada@example.com")).toEqual(ada);
  const [one, two] = await Promise.all([person("bob@example.com"), person("bob@example.com")]);
  expect(one).toEqual(two);
});

test("people: an identity links once by verified email, then by subject: a changed email follows it unless another person holds it; one subject per provider", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const link = (provider: "google" | "cloudflare", subject: string, email: string) =>
    c.linkIdentity({ provider, subject, email });
  // the Google subject adopts the person the email names, and follows them to a new address
  expect(await link("google", "g-ada", ada.email)).toEqual(ada);
  expect(await link("google", "g-ada", "ada2@example.com")).toEqual({
    id: ada.id,
    email: "ada2@example.com",
  });
  expect(await c.identity("google", "g-ada")).toEqual({ id: ada.id, email: "ada2@example.com" });
  // not onto an address another person holds
  await expect(link("google", "g-ada", bob.email)).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
  });
  // a second Google subject cannot adopt the linked person; a Cloudflare one can
  await expect(link("google", "g-other", "ada2@example.com")).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
  });
  expect(await link("cloudflare", "cf-ada", "ada2@example.com")).toMatchObject({ id: ada.id });
  // a subject nobody has seen, with a new email, is a new person
  const carol = await link("google", "g-carol", "carol@example.com");
  expect(await c.identity("google", "g-carol")).toEqual(carol);
  expect(carol).not.toMatchObject({ id: ada.id });
  // three first sign-ins of one subject at once: one person, one identity
  const [first, ...again] = await Promise.all(
    [1, 2, 3].map(() => link("google", "g-dan", "dan@example.com")),
  );
  expect(again).toEqual([first, first]);
  expect(await rows("select user_id from identities where subject = 'g-dan'")).toEqual([
    { user_id: first!.id },
  ]);
});

test("people: a person with more than one sign-in keeps their email when one sign-in's provider reports another address; with one sign-in, the email follows it", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const link = (provider: "google" | "github", subject: string, email: string) =>
    c.linkIdentity({ provider, subject, email });
  expect(await link("google", "g-ada", ada.email)).toEqual(ada);
  // GitHub's subject moved onto Ada by an operator, as when two of her accounts are merged
  expect(await link("github", "gh-ada", "ada@elsewhere.example")).not.toMatchObject({ id: ada.id });
  await rows(
    `update identities set user_id = '${ada.id}' where provider = 'github' and subject = 'gh-ada'`,
  );
  await rows(`delete from users where email = 'ada@elsewhere.example'`);
  // GitHub still says her other address: Ada keeps hers, and Google's sign-in still finds her
  expect(await link("github", "gh-ada", "ada@elsewhere.example")).toEqual(ada);
  expect(await c.identity("google", "g-ada")).toEqual(ada);
  // one sign-in only: its new address follows it
  const bob = await link("google", "g-bob", "bob@example.com");
  expect(await link("google", "g-bob", "bob2@example.com")).toEqual({
    id: bob.id,
    email: "bob2@example.com",
  });
});

test("people: a signed-in person adds a sign-in to their account: the subject becomes theirs, again unchanged, never one another person holds or a second of the provider, and it never moves their email", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const add = (userId: string, provider: "google" | "github", subject: string) =>
    c.addIdentity({ userId, provider, subject, now: NOW });
  expect(await add(ada.id, "github", "gh-ada")).toEqual(ada);
  expect(await c.identity("github", "gh-ada")).toEqual(ada);
  expect(await add(ada.id, "github", "gh-ada")).toEqual(ada);
  await expect(add(bob.id, "github", "gh-ada")).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: "This GitHub account signs in to another iterate account.",
  });
  await expect(add(ada.id, "github", "gh-ada-2")).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: "Your account already signs in with another GitHub account.",
  });
  expect(await c.identity("github", "gh-ada-2")).toBeNull();
  // signing in with it later finds Ada, and the address GitHub reports is not hers: she keeps
  // hers, though it is her only sign-in
  expect(
    await c.linkIdentity({ provider: "github", subject: "gh-ada", email: "ada@elsewhere.example" }),
  ).toEqual(ada);
  expect(await c.user(ada.id)).toEqual(ada);
  // nor can any other write, an older version's `linkIdentity` among them: the database refuses it
  await expect(
    env.DB.prepare("update users set email = 'ada@elsewhere.example' where id = ?")
      .bind(ada.id)
      .run(),
  ).rejects.toThrow(/an added sign-in keeps its person's email/);
  expect(await c.user(ada.id)).toEqual(ada);
  // two people adding one subject at once: one holds it, the other is refused
  const both = await Promise.allSettled([
    add(ada.id, "google", "g-x"),
    add(bob.id, "google", "g-x"),
  ]);
  expect(both.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await rows("select count(*) as n from identities where subject = 'g-x'")).toEqual([
    { n: 1 },
  ]);
});

test("organizations: created with the caller its owner; the operator alone names another owner, one who exists", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const org = await c.createOrganization(as(ada), { name: "  Booper " });
  expect(org).toEqual({
    id: expect.stringMatching(/^org_[0-9a-f]{32}$/),
    name: "Booper",
    role: "owner",
    projects: 0,
  });
  expect(await c.organization(org.id)).toEqual({ id: org.id, name: "Booper", projects: 0 });
  expect(await c.members(org.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
  expect(await c.accessibleTo(ada.id)).toEqual({ organizations: [org], projects: [] });
  await expect(c.createOrganization(as(ada), { name: "X", ownerId: bob.id })).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
  await expect(c.createOrganization(admin, { name: "X", ownerId: "user_nobody" })).rejects.toThrow(
    /No user/,
  );
  // named by email, held by id
  const named = await c.createOrganization(admin, { name: "Named", ownerId: ada.email });
  expect(named).toEqual({ id: expect.stringMatching(/^org_/), name: "Named", projects: 0 });
  expect(await c.members(named.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
});

test("organizations: an owner renames, adds and removes members; the last owner stays; a stranger is refused", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const org = await c.createOrganization(as(ada), { name: "Booper" });
  await expect(c.renameOrganization(as(bob), org.id, "Mine")).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "Only an owner can rename an organization.",
  });
  await expect(c.renameOrganization(as(ada), "org_nobody", "Mine")).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "You cannot rename that organization.",
  });
  expect(await c.renameOrganization(as(ada), org.id, "Booper Inc")).toEqual({
    id: org.id,
    name: "Booper Inc",
    projects: 0,
  });
  const add = (caller: Caller, userId: string, role: "owner" | "member" = "member") =>
    c.addMember(caller, org.id, { userId, role });
  await expect(add(as(ada), "user_nobody")).rejects.toThrow(/No user/);
  // a stranger naming nobody learns nothing about who exists
  await expect(add(as(bob), "user_nobody")).rejects.toMatchObject({ code: "FORBIDDEN" });
  // by email, held by id; the same again is the same membership
  expect(await add(as(ada), bob.email)).toBe(bob.id);
  expect(await add(as(ada), bob.id)).toBe(bob.id);
  expect(await c.accessibleTo(bob.id)).toMatchObject({
    organizations: [{ id: org.id, name: "Booper Inc", role: "member", projects: 0 }],
  });
  // the last owner is neither removed nor demoted
  await expect(c.removeMember(as(ada), org.id, { userId: ada.id })).rejects.toThrow(
    "An organization keeps at least one owner.",
  );
  await expect(add(as(ada), ada.id)).rejects.toThrow("An organization keeps at least one owner.");
  expect(await c.removeMember(as(ada), org.id, { userId: bob.email })).toBe(bob.id);
  expect(await c.accessibleTo(bob.id)).toMatchObject({ organizations: [] });
  await expect(c.removeMember(as(ada), org.id, { userId: bob.id })).rejects.toThrow(
    "Not a member of that organization.",
  );
});

test("organizations: owners demoting or removing each other at once leave exactly one owner, and a demotion racing the demoted's own promotion stands", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const twoOwners = async (name: string) => {
    const org = await c.createOrganization(as(ada), { name });
    await c.addMember(as(ada), org.id, { userId: bob.id, role: "owner" });
    return org.id;
  };
  const owners = async (orgId: string) =>
    (await c.members(orgId)).filter((member) => member.role === "owner");
  const demoted = await twoOwners("Demoted");
  await Promise.allSettled([
    c.addMember(as(ada), demoted, { userId: bob.id, role: "member" }),
    c.addMember(as(bob), demoted, { userId: ada.id, role: "member" }),
  ]);
  expect(await owners(demoted)).toHaveLength(1);
  const removed = await twoOwners("Removed");
  await Promise.allSettled([
    c.removeMember(as(ada), removed, { userId: bob.id }),
    c.removeMember(as(bob), removed, { userId: ada.id }),
  ]);
  expect(await owners(removed)).toHaveLength(1);
  // in either order the demotion stands: a promotion after it is no longer an owner's
  const promoted = await twoOwners("Promoted");
  await Promise.allSettled([
    c.addMember(as(ada), promoted, { userId: bob.id, role: "member" }),
    c.addMember(as(bob), promoted, { userId: bob.id, role: "owner" }),
  ]);
  expect(await owners(promoted)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
});

test("organizations: a removed owner's own verbs are refused and write nothing; an organization is deleted only while it holds no project, and its memberships and invitations with it", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const org = await c.createOrganization(as(ada), { name: "Booper" });
  await c.addMember(as(ada), org.id, { userId: bob.id, role: "owner" });
  await c.removeMember(as(ada), org.id, { userId: bob.id });
  await expect(
    c.createInvitation(
      as(bob),
      org.id,
      { tokenHash: "h", role: "owner", expiresAt: NOW + DAY },
      NOW,
    ),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "Only an owner can invite people to an organization.",
  });
  await expect(c.deleteOrganization(as(bob), org.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await c.createProject(as(ada), { project: "dawg", organizationId: org.id });
  await expect(c.deleteOrganization(as(ada), org.id)).rejects.toThrow(/still holds 1 project/);
  const empty = await c.createOrganization(as(ada), { name: "Empty" });
  await c.addMember(as(ada), empty.id, { userId: bob.id, role: "member" });
  await c.createInvitation(
    as(ada),
    empty.id,
    { tokenHash: "hash-e", role: "member", expiresAt: NOW + DAY },
    NOW,
  );
  await c.deleteOrganization(as(ada), empty.id);
  expect(await c.organization(empty.id)).toBeNull();
  expect(await c.accessibleTo(bob.id)).toEqual({ organizations: [], projects: [] });
  expect(await rows("select id from invitations")).toEqual([]);
  // a delete racing a project's creation in it: the project in its organization, or neither
  const raced = await c.createOrganization(as(ada), { name: "Raced" });
  await Promise.allSettled([
    c.deleteOrganization(as(ada), raced.id),
    c.createProject(as(ada), { project: "raced", organizationId: raced.id }),
  ]);
  expect(await c.organization(raced.id)).toEqual(
    (await c.project("raced")) ? expect.objectContaining({ projects: 1 }) : null,
  );
});

test("invitations: an owner creates a link — the record by id, never the hash; the holder previews the organization; a stranger or a member cannot create one, nor one already expired", async () => {
  await emptyTables();
  const { ada, bob, org, invitation } = await invited();
  expect(invitation).toEqual({
    id: expect.stringMatching(/^inv_[0-9a-f]{32}$/),
    orgId: org.id,
    role: "member",
    emailHint: "bob@example.com",
    expiresAt: new Date(NOW + DAY).toISOString(),
  });
  expect(await c.invitation("hash-1", bob.id, NOW)).toEqual({
    ...invitation,
    orgName: "Booper",
    status: "pending",
    member: false,
    acceptedByYou: false,
  });
  expect(await c.invitation("hash-1", ada.id, NOW)).toMatchObject({ member: true });
  expect(await c.invitation("hash-1", null, NOW)).toMatchObject({ member: false });
  expect(await c.invitation("hash-nobody", bob.id, NOW)).toBeNull();
  const create = (caller: Caller, expiresAt = NOW + DAY) =>
    c.createInvitation(caller, org.id, { tokenHash: "hash-2", role: "owner", expiresAt }, NOW);
  await expect(create(as(bob))).rejects.toMatchObject({ code: "FORBIDDEN" });
  await c.addMember(as(ada), org.id, { userId: bob.id, role: "member" });
  await expect(create(as(bob))).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(create(as(ada), NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await create(as(ada))).toMatchObject({ emailHint: null });
});

test("invitations: accepted, the person joins in the link's role — once: again by them is the same answer, a second person is refused, and a member removed since cannot reuse it, even at the same millisecond", async () => {
  await emptyTables();
  const { ada, bob, carol, org, invitation } = await invited("owner");
  const accepted = { invitation, userId: bob.id, role: "owner", accepted: true };
  expect(await c.acceptInvitation(as(bob), "hash-1", NOW + 1)).toEqual(accepted);
  expect(await c.accessibleTo(bob.id)).toMatchObject({
    organizations: [{ id: org.id, name: "Booper", role: "owner", projects: 0 }],
  });
  expect(await c.acceptInvitation(as(bob), "hash-1", NOW + 2)).toEqual(accepted);
  await expect(c.acceptInvitation(as(carol), "hash-1", NOW + 3)).rejects.toThrow(
    "This invitation was already used by someone else.",
  );
  expect(await c.accessibleTo(carol.id)).toMatchObject({ organizations: [] });
  expect(await c.invitation("hash-1", carol.id, NOW + 3)).toMatchObject({
    status: "accepted",
    acceptedByYou: false,
  });
  expect(await c.invitation("hash-1", bob.id, NOW + 3)).toMatchObject({
    status: "accepted",
    member: true,
    acceptedByYou: true,
  });
  // once used it is a membership: revoked it is not, removed it is — and the link stays spent, for
  // a retry carrying the acceptance's own `now` too (one isolate's clock)
  await expect(c.revokeInvitation(as(ada), org.id, invitation.id, NOW)).rejects.toThrow(
    "This invitation was already accepted; remove the member instead.",
  );
  await c.removeMember(as(ada), org.id, { userId: bob.id });
  await expect(c.acceptInvitation(as(bob), "hash-1", NOW + 1)).rejects.toThrow(
    "This invitation was already used by someone else.",
  );
  expect(await c.members(org.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
});

test("invitations: accepted at once — by ten people, exactly one joins; by one person twice at one millisecond, both are answered accepted; against a revoke, one of the two wins", async () => {
  await emptyTables();
  const { org } = await invited();
  const guests = await Promise.all(
    Array.from({ length: 10 }, (_, index) => person(`guest${index}@example.com`)),
  );
  const answers = await Promise.allSettled(
    guests.map((guest) => c.acceptInvitation(as(guest), "hash-1", NOW + 1)),
  );
  expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
  expect(await c.members(org.id)).toHaveLength(2);

  await emptyTables();
  const again = await invited();
  const twice = await Promise.all([
    c.acceptInvitation(as(again.bob), "hash-1", NOW + 1),
    c.acceptInvitation(as(again.bob), "hash-1", NOW + 1),
  ]);
  expect(twice.map((answer) => answer.accepted)).toEqual([true, true]);
  expect(await c.members(again.org.id)).toHaveLength(2);

  await emptyTables();
  const revoked = await invited();
  await Promise.allSettled([
    c.revokeInvitation(as(revoked.ada), revoked.org.id, revoked.invitation.id, NOW + 1),
    c.acceptInvitation(as(revoked.bob), "hash-1", NOW + 1),
  ]);
  const joined = (await c.members(revoked.org.id)).some(({ userId }) => userId === revoked.bob.id);
  expect(await c.invitation("hash-1", revoked.bob.id, NOW + 1)).toMatchObject({
    status: joined ? "accepted" : "revoked",
  });
});

test("invitations: expired or revoked, a link is refused and joins nobody; revoked again is a no-op; only an owner of that organization revokes", async () => {
  await emptyTables();
  const { ada, bob, org, invitation } = await invited();
  expect(await c.invitation("hash-1", bob.id, NOW + DAY)).toMatchObject({ status: "expired" });
  await expect(c.acceptInvitation(as(bob), "hash-1", NOW + DAY)).rejects.toThrow(
    "This invitation has expired.",
  );
  await expect(c.revokeInvitation(as(bob), org.id, invitation.id, NOW)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const other = await c.createOrganization(as(ada), { name: "Other" });
  await expect(c.revokeInvitation(as(ada), other.id, invitation.id, NOW)).rejects.toThrow(
    "No such invitation to this organization.",
  );
  expect(await c.revokeInvitation(as(ada), org.id, invitation.id, NOW)).toEqual(invitation);
  expect(await c.revokeInvitation(as(ada), org.id, invitation.id, NOW + 1)).toEqual(invitation);
  expect(await c.invitation("hash-1", bob.id, NOW)).toMatchObject({ status: "revoked" });
  await expect(c.acceptInvitation(as(bob), "hash-1", NOW)).rejects.toThrow(
    "This invitation was revoked.",
  );
  expect(await c.accessibleTo(bob.id)).toMatchObject({ organizations: [] });
});

test("invitations: a person who already belongs keeps their role and leaves the link open; the operator accepts nothing; a deleted organization's links name nothing", async () => {
  await emptyTables();
  const { ada, bob, org } = await invited("member");
  expect(await c.acceptInvitation(as(ada), "hash-1", NOW)).toMatchObject({
    role: "owner",
    accepted: false,
  });
  expect(await c.members(org.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
  expect(await c.invitation("hash-1", bob.id, NOW)).toMatchObject({ status: "pending" });
  await expect(c.acceptInvitation(admin, "hash-1", NOW)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(c.acceptInvitation(as(bob), "hash-nobody", NOW)).rejects.toThrow(
    "This invitation link is not valid.",
  );
  await c.deleteOrganization(as(ada), org.id);
  expect(await c.invitation("hash-1", bob.id, NOW)).toBeNull();
  await expect(c.acceptInvitation(as(bob), "hash-1", NOW)).rejects.toThrow(
    "This invitation link is not valid.",
  );
});

test("projects: a slug is one project across every organization: the same organization's again is the same project, another's is refused and makes nothing", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const org = await c.createOrganization(as(ada), { name: "Booper" });
  const dawg = await c.createProject(as(ada), { project: "Dawg!", organizationId: org.id });
  expect(dawg).toEqual({
    id: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    slug: "dawg",
    orgId: org.id,
  });
  expect(await c.project("dawg")).toEqual(dawg);
  expect(await c.project(dawg.id)).toEqual(dawg);
  expect(await c.accessibleTo(ada.id)).toMatchObject({ projects: [{ ...dawg, role: "owner" }] });
  expect(await c.createProject(as(ada), { project: "dawg" })).toEqual(dawg);
  // Bob has no organization yet, and the operator's own does not exist: neither refusal makes one
  await expect(c.createProject(as(bob), { project: "dawg" })).rejects.toMatchObject({
    code: "PROJECT_NAME_TAKEN",
  });
  await expect(c.createProject(admin, { project: "dawg" })).rejects.toMatchObject({
    code: "PROJECT_NAME_TAKEN",
  });
  // naming an organization it does not belong to is refused before the slug is looked at
  for (const project of ["x", "dawg"])
    await expect(
      c.createProject(as(bob), { project, organizationId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await c.accessibleTo(bob.id)).toEqual({ organizations: [], projects: [] });
  expect(await c.organizations()).toHaveLength(1);
});

test("projects: an owner or the operator deletes a project's row, which frees its slug; a member, a stranger, or a project already gone is refused; its hostname claim outlives the row until released", async () => {
  await emptyTables();
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const org = await c.createOrganization(as(ada), { name: "Booper" });
  await c.addMember(as(ada), org.id, { userId: bob.id, role: "member" });
  const dawg = await c.createProject(as(ada), { project: "dawg", organizationId: org.id });
  await c.claimHostname(dawg.id, "dawg.example.com");
  await expect(c.deleteProject(as(bob), dawg.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await c.deleteProject(as(ada), "dawg")).toEqual(dawg);
  expect(await c.project(dawg.id)).toBeNull();
  // its hostname claim outlives the row (it admits nothing: no row to join), holding the name
  // until the deletion saga releases it — after Cloudflare let go of the custom hostname
  expect(await c.projectByHostname(["dawg.example.com"])).toBeNull();
  expect(await rows("select hostname, project_id as projectId from project_hostnames")).toEqual([
    { hostname: "dawg.example.com", projectId: dawg.id },
  ]);
  const other = await c.createProject(as(ada), { project: "other", organizationId: org.id });
  await expect(c.claimHostname(other.id, "dawg.example.com")).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await c.releaseHostname(dawg.id, "dawg.example.com");
  await c.claimHostname(other.id, "dawg.example.com");
  expect((await c.projectByHostname(["dawg.example.com"]))?.project).toEqual(other);
  await expect(c.deleteProject(as(ada), dawg.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const again = await c.createProject(as(ada), { project: "dawg", organizationId: org.id });
  expect(again).not.toMatchObject({ id: dawg.id });
  expect(await c.deleteProject(admin, again.id)).toEqual(again);
});

test("projects: with no organization named: the person's first by name, made on first use after their email, one when created at once; the operator's own organization, made on first use", async () => {
  await emptyTables();
  const ada = await person("ada.lovelace@example.com");
  const [one, two] = await Promise.all([
    c.createProject(as(ada), { project: "one" }),
    c.createProject(as(ada), { project: "two" }),
  ]);
  expect(one).toMatchObject({ orgId: two.orgId });
  expect(await c.accessibleTo(ada.id)).toMatchObject({
    organizations: [{ id: one.orgId, name: "ada.lovelace", role: "owner", projects: 2 }],
  });
  const bob = await person("bob@example.com");
  const [first, again] = await Promise.all([
    c.createProject(as(bob), { project: "same" }),
    c.createProject(as(bob), { project: "same" }),
  ]);
  expect(first).toEqual(again);
  expect((await c.accessibleTo(bob.id)).organizations).toHaveLength(1);
  expect(await c.createProject(admin, { project: "ops" })).toMatchObject({ orgId: ADMIN_ORG_ID });
  expect(await c.organization(ADMIN_ORG_ID)).toEqual({
    id: ADMIN_ORG_ID,
    name: "admin",
    projects: 1,
  });
  expect(await c.members(ADMIN_ORG_ID)).toEqual([]);
  // the operator names any organization, one that exists
  expect(
    await c.createProject(admin, { project: "three", organizationId: one.orgId }),
  ).toMatchObject({ orgId: one.orgId });
  await expect(
    c.createProject(admin, { project: "four", organizationId: "org_nobody" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("projects: the operator alone restores a project under its archived id: the same archive again is the same project, also at once; a slug or an id bound elsewhere is refused", async () => {
  await emptyTables();
  const restore = (project: string, restoreProjectId: string, caller = admin) =>
    c.createProject(caller, { project, restoreProjectId });
  expect(await restore("garple", "prj_garple")).toEqual({
    id: "prj_garple",
    slug: "garple",
    orgId: ADMIN_ORG_ID,
  });
  expect(await restore("garple", "prj_garple")).toMatchObject({ id: "prj_garple" });
  await expect(restore("garple", "prj_other")).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: expect.stringMatching(/not the restored id/),
  });
  await expect(restore("elsewhere", "prj_garple")).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: expect.stringMatching(/already belongs/),
  });
  await expect(restore("empty", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const ada = await person("ada@example.com");
  await expect(restore("x", "prj_x", as(ada))).rejects.toMatchObject({ code: "FORBIDDEN" });
  const [one, two] = await Promise.all([
    restore("lispwoso", "prj_l"),
    restore("lispwoso", "prj_l"),
  ]);
  expect(one).toEqual(two);
  expect(await c.projects()).toHaveLength(2);
});

test.for([
  ["Booper", "booper"],
  ["  My Project! v2 ", "my-project-v2"],
  ["--dawg--", "dawg"],
  ["!!!", ""],
] as const)("projects: projectSlug(%j) is %j", ([name, slug]) => {
  expect(projectSlug(name)).toBe(slug);
});

test("hostnames: a claim routes the hostname and the names under it to its project; again for the same project is a no-op; another project's hostname, or a name under it, is refused; a release drops only the releasing project's claim", async () => {
  await emptyTables();
  const shop = await c.createProject(admin, { project: "shop" });
  const blog = await c.createProject(admin, { project: "blog" });
  const lookup = (host: string) => c.projectByHostname([host, host.split(".").slice(1).join(".")]);
  expect(await lookup("iterate.shop.test")).toBeNull();
  await c.claimHostname(shop.id, "iterate.shop.test");
  await c.claimHostname(shop.id, "iterate.shop.test");
  // the most specific name the lookup was handed wins: the apex, then `<routingSlug>.` under it
  for (const host of ["iterate.shop.test", "notes.iterate.shop.test"])
    expect(await lookup(host)).toEqual({ hostname: "iterate.shop.test", project: shop });
  await expect(c.claimHostname(blog.id, "iterate.shop.test")).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "The hostname 'iterate.shop.test' belongs to another project.",
  });
  // `*.iterate.shop.test` points at us: a name under it is shop's, never another project's
  await expect(c.claimHostname(blog.id, "notes.iterate.shop.test")).rejects.toThrow(
    "'notes.iterate.shop.test' is under 'iterate.shop.test', which belongs to another project.",
  );
  await c.claimHostname(shop.id, "www.iterate.shop.test"); // the holder may name one of its own
  await c.claimHostname(blog.id, "shop.test"); // a name ABOVE another's is no conflict: the most specific routes
  expect(await lookup("www.iterate.shop.test")).toEqual({
    hostname: "www.iterate.shop.test",
    project: shop,
  });
  // shop's own name is now under blog's: shop claiming it again still holds it, a new name is refused
  await c.claimHostname(shop.id, "iterate.shop.test");
  await expect(c.claimHostname(shop.id, "api.shop.test")).rejects.toThrow(
    "'api.shop.test' is under 'shop.test', which belongs to another project.",
  );
  await expect(c.claimHostname("prj_nobody", "x.test")).rejects.toThrow('No project "prj_nobody".');
  await c.releaseHostname(blog.id, "iterate.shop.test");
  expect(await lookup("iterate.shop.test")).toMatchObject({ project: shop });
  await c.releaseHostname(shop.id, "iterate.shop.test");
  await c.releaseHostname(shop.id, "www.iterate.shop.test");
  await c.releaseHostname(blog.id, "shop.test");
  expect(await lookup("notes.iterate.shop.test")).toBeNull();
  // a name and one above it claimed at once by two projects: one of the two orders
  const [below, above] = await Promise.allSettled([
    c.claimHostname(shop.id, "a.race.test"),
    c.claimHostname(blog.id, "race.test"),
  ]);
  expect(above).toMatchObject({ status: "fulfilled" });
  expect(
    await rows("select hostname from project_hostnames where hostname like '%race.test'"),
  ).toHaveLength(below.status === "fulfilled" ? 2 : 1);
});

test("hostnames: a project's primary hostname reads back only while the project holds its claim; null clears it", async () => {
  await emptyTables();
  const shop = await c.createProject(admin, { project: "shop" });
  await c.claimHostname(shop.id, "www.shop.test");
  await c.setPrimaryHostname(shop.id, "www.shop.test");
  expect(await c.primaryHostnameOf(shop.id)).toBe("www.shop.test");
  await c.setPrimaryHostname(shop.id, "shop.test"); // not claimed: no primary
  expect(await c.primaryHostnameOf(shop.id)).toBeNull();
  await c.setPrimaryHostname(shop.id, "www.shop.test");
  await c.releaseHostname(shop.id, "www.shop.test");
  expect(await c.primaryHostnameOf(shop.id)).toBeNull();
  await c.claimHostname(shop.id, "www.shop.test");
  expect(await c.primaryHostnameOf(shop.id)).toBe("www.shop.test");
  await c.setPrimaryHostname(shop.id, null);
  expect(await c.primaryHostnameOf(shop.id)).toBeNull();
});

// THE INTEGRATION ROUTES — catalog.ts `routeIntegration`, one row each: who holds the account, who
// routes it, what happens. First owner wins, nothing steals.
test.for([
  {
    rule: "an unrouted account: routed to the connection",
    holder: null,
    route: { project: "shop", path: "/integrations/slack/acme" },
    refused: null,
  },
  {
    rule: "again by the same connection: a no-op",
    holder: { project: "shop", path: "/integrations/slack/acme" },
    route: { project: "shop", path: "/integrations/slack/acme" },
    refused: null,
  },
  {
    rule: "another connection of the same project: refused, naming the holder",
    holder: { project: "shop", path: "/integrations/slack/acme" },
    route: { project: "shop", path: "/integrations/slack/other" },
    refused: "The slack account 'T1' is already connected at /integrations/slack/acme.",
  },
  {
    rule: "another project: refused",
    holder: { project: "shop", path: "/integrations/slack/acme" },
    route: { project: "blog", path: "/integrations/slack/acme" },
    refused: "The slack account 'T1' is connected to another project.",
  },
  {
    rule: "a project the catalog never heard of: refused",
    holder: null,
    route: { project: "prj_nobody", path: "/integrations/slack/acme" },
    refused: 'No project "prj_nobody".',
  },
] as const)("integration routes: $rule", async ({ holder, route, refused }) => {
  await emptyTables();
  const ids: Record<string, string> = {
    shop: (await c.createProject(admin, { project: "shop" })).id,
    blog: (await c.createProject(admin, { project: "blog" })).id,
  };
  const projectId = (name: string) => ids[name] || name;
  if (holder) await c.routeIntegration("slack", "T1", projectId(holder.project), holder.path);
  const routing = c.routeIntegration("slack", "T1", projectId(route.project), route.path);
  if (refused)
    await expect(routing).rejects.toMatchObject({ code: "INVALID_INPUT", message: refused });
  else await routing;
  const winner = holder || (refused ? null : route);
  expect(await c.integrationRoute("slack", "T1")).toEqual(
    winner && { projectId: projectId(winner.project), path: winner.path },
  );
  expect(await c.integrationRoute("github", "T1")).toBeNull(); // a route is per provider
});

test("integration routes: released by the connection (project and path), after which another project may route the account; a connection holds one account; two projects routing one account at once leave one holder", async () => {
  await emptyTables();
  const shop = await c.createProject(admin, { project: "shop" });
  const blog = await c.createProject(admin, { project: "blog" });
  await c.routeIntegration("slack", "T1", shop.id, "/integrations/slack/acme");
  await c.releaseIntegrationRoutes(blog.id, "/integrations/slack/acme");
  await c.releaseIntegrationRoutes(shop.id, "/integrations/slack/other");
  expect(await c.integrationRoute("slack", "T1")).toMatchObject({ projectId: shop.id });
  await c.routeIntegration("slack", "T2", shop.id, "/integrations/slack/acme");
  expect(await c.integrationRoute("slack", "T1")).toBeNull();
  await c.releaseIntegrationRoutes(shop.id, "/integrations/slack/acme");
  expect(await c.integrationRoute("slack", "T2")).toBeNull();
  await c.routeIntegration("slack", "T2", blog.id, "/integrations/slack/acme");
  expect(await c.integrationRoute("slack", "T2")).toMatchObject({ projectId: blog.id });
  // fired together: exactly one wins, and the other is refused
  const raced = await Promise.allSettled([
    c.routeIntegration("github", "I9", shop.id, "/integrations/github/acme"),
    c.routeIntegration("github", "I9", blog.id, "/integrations/github/acme"),
  ]);
  expect(raced.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await rows("select project_id from integration_routes where external_id = 'I9'")).toEqual([
    { project_id: raced[0]!.status === "fulfilled" ? shop.id : blog.id },
  ]);
});

test("integration routes: a deleted project's routes go with its row, so another project may route the account; a refused deletion keeps them", async () => {
  await emptyTables();
  const shop = await c.createProject(admin, { project: "shop" });
  const blog = await c.createProject(admin, { project: "blog" });
  await c.routeIntegration("slack", "T1", shop.id, "/integrations/slack/acme");
  await c.routeIntegration("slack", "T2", blog.id, "/integrations/slack/acme");
  const stranger = await person("eve@example.com");
  await expect(c.deleteProject(as(stranger), shop.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await c.integrationRoute("slack", "T1")).toMatchObject({ projectId: shop.id });
  await c.deleteProject(admin, shop.id);
  expect(await c.integrationRoute("slack", "T1")).toBeNull();
  expect(await c.integrationRoute("slack", "T2")).toMatchObject({ projectId: blog.id });
  await c.routeIntegration("slack", "T1", blog.id, "/integrations/slack/other");
  expect(await c.integrationRoute("slack", "T1")).toMatchObject({ projectId: blog.id });
});

// ── the OAuth provider's grants (oauth-grants.ts): KV's read, expiry and list semantics ──

const T = 1_790_000_000;
const grants = new OAuthGrantTable(env.DB);

test("grants: a read answers the last write, whole; an expired grant reads and lists as absent, and goes on the next write", async () => {
  await emptyTables();
  expect(await grants.get("grant:user_a:g1", T)).toBeNull();
  await grants.put("grant:user_a:g1", '{"authCodeId":"x"}', T + 600, T);
  expect(await grants.get("grant:user_a:g1", T + 599)).toBe('{"authCodeId":"x"}');
  expect(await grants.get("grant:user_a:g1", T + 600)).toBeNull();
  expect(await grants.list("grant:user_a:", {}, T + 600)).toEqual({
    keys: [],
    list_complete: true,
  });
  // the code exchange rewrites the grant: its refresh token, and no expiry any more
  await grants.put("grant:user_a:g1", '{"refreshTokenId":"r1"}', null, T);
  expect(await grants.get("grant:user_a:g1", T + 10_000)).toBe('{"refreshTokenId":"r1"}');
  await grants.put("grant:user_a:g2", "{}", T + 600, T);
  await grants.put("grant:user_a:g3", "{}", null, T + 600);
  expect(await rows("select key from oauth_grants order by key")).toEqual([
    { key: "grant:user_a:g1" },
    { key: "grant:user_a:g3" },
  ]);
  await grants.delete("grant:user_a:g1");
  expect(await grants.get("grant:user_a:g1", T)).toBeNull();
});

test("grants: a list is one user's keys in key order, paged by cursor, with each one's expiry — a range of the key's index, whatever sorts next to it", async () => {
  await emptyTables();
  for (const id of ["g3", "g1", "g2"]) await grants.put(`grant:user_a:${id}`, "{}", null, T);
  await grants.put("grant:user_a:g4", "{}", T + 600, T);
  // `_` is a LIKE wildcard, and `9` and `;` sort just before and just after `:`: none of these are
  // user_a's
  for (const key of ["grant:user_ab:g1", "grant:userXa:g1", "grant:user_a9", "grant:user_a;g1"])
    await grants.put(key, "{}", null, T);
  const first = await grants.list("grant:user_a:", { limit: 3 }, T);
  expect(first).toEqual({
    keys: [{ name: "grant:user_a:g1" }, { name: "grant:user_a:g2" }, { name: "grant:user_a:g3" }],
    list_complete: false,
    cursor: "grant:user_a:g3",
  });
  expect(await grants.list("grant:user_a:", { limit: 3, cursor: first.cursor }, T)).toEqual({
    keys: [{ name: "grant:user_a:g4", expiration: T + 600 }],
    list_complete: true,
  });
  expect((await grants.list("grant:", {}, T)).keys).toHaveLength(8);
  // a cursor before the prefix starts at the prefix; one past the range answers nothing
  expect((await grants.list("grant:user_a:", { cursor: "grant:" }, T)).keys).toHaveLength(4);
  expect(await grants.list("grant:user_a:", { cursor: "grant:user_a;" }, T)).toEqual({
    keys: [],
    list_complete: true,
  });
  // SQLite searches the key's index for the range; it reads no row outside it
  const listing = listOAuthGrants.query({
    cursor: "",
    prefix: "grant:user_a:",
    end: "grant:user_a;",
    now: T,
    limit: 1001,
  });
  const plan = await env.DB.prepare(`explain query plan ${listing.sql}`)
    .bind(...listing.args)
    .all<{ detail: string }>();
  expect(plan.results[0]!.detail).toMatch(
    /^SEARCH oauth_grants USING INDEX \S+ \(key>\? AND key<\?\)$/,
  );
});

/** Every row starts from empty tables (the migrations stay): the rows share this file's D1. */
async function emptyTables() {
  await env.DB.batch(
    [
      "project_primary_hostnames",
      "project_hostnames",
      "integration_routes",
      "invitations",
      "projects",
      "memberships",
      "organizations",
      "identities",
      "users",
      "oauth_grants",
    ].map((table) => env.DB.prepare(`delete from ${table}`)),
  );
}

const person = (email: string) => c.createUser({ email });

const as = (user: { id: string; email: string }): Caller => ({
  principal: { actor: user.id, email: user.email },
});

const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;

const NOW = Date.parse("2030-01-01T00:00:00Z");
const DAY = 86_400_000;

/** Ada's organization and one open link to it (`hash-1`), expiring in a day; Bob and Carol, who
 *  belong to nothing. */
async function invited(role: "owner" | "member" = "member") {
  const ada = await person("ada@example.com");
  const bob = await person("bob@example.com");
  const carol = await person("carol@example.com");
  const org = await c.createOrganization(as(ada), { name: "Booper" });
  const invitation = await c.createInvitation(
    as(ada),
    org.id,
    { tokenHash: "hash-1", role, emailHint: "bob@example.com", expiresAt: NOW + DAY },
    NOW,
  );
  return { ada, bob, carol, org, invitation };
}
