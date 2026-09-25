// e2e/organizations.e2e.test.ts — THE CONTROL PLANE through a person's session: every verb on
// `session.organizations` (and `projects.create` in an organization) is one call on the control
// plane (src/control-plane/), which writes its catalog and lands the FACTS on the organization's
// own record (`organization` facet at `/organizations/<id>`) and on each member's account
// (`account` facet at `/users/<id>`, `memberships`) — the two folds the dash reads through live
// state. A verb answers only once its facts are FOLDED (src/session.ts `foldPlatformFacts`), so
// these rows read the folds at once, never by polling; only another person's reach waits, on the
// edge's memo, and a first project's membership on the person's account, which lands in the
// background. These rows read what a client can: the verbs' answers, the list through the
// person's reach, and the two folds. Every row mints its own person, organization and project; the
// files run in parallel.
import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import { adminCredentials, rejection, session, until } from "./support/client.ts";
import { freshDnsSafeProjectSlug } from "./support/project-host.ts";

/** A person's reach as the edge memoizes it (src/control-plane/edge.ts, five seconds): a request
 *  drops the memo on the isolate it was made on, so ANOTHER person's socket — possibly on another
 *  isolate of a deployed worker — may answer from a memo up to five seconds old. A cross-session
 *  observation is bounded by that plus the landing, well under the default twenty. */
const REACH_MEMO_BOUND_MS = 20_000;

test("organizations.create({ name }) answers the owner's row, and the membership is folded twice — on the person's account and on the organization's own record", async () => {
  const slug = freshDnsSafeProjectSlug("org-create");
  const name = `Organization ${slug}`;
  const api = person(`${slug}@example.com`);
  const { actor: userId } = await api.whoami();
  const org = await api.organizations.create({ name });
  // the answer: the id the control plane minted, the asker its owner, no project yet
  expect(org).toEqual({
    id: expect.stringMatching(/^org_[0-9a-f]{32}$/),
    name,
    role: "owner",
    projects: 0,
  });
  // the catalog, read through the person's memberships
  expect(await api.organizations.list()).toContainEqual(org);
  // THE ACCOUNT: the verb folds `organization/member-added` on `/users/<id>` before it answers
  expect((await memberships(api))[org.id]).toEqual({ role: "owner", since: expect.any(String) });
  // THE ORGANIZATION'S RECORD: its name, its members — the context a member holds by identity
  using organization = await api.organizations.get(org.id);
  expect(await record(organization)).toMatchObject({
    name,
    deletedAt: null,
    members: { [userId]: { role: "owner", since: expect.any(String) } },
    projects: {},
  });
});

test("projects.create({ project, orgId }) lands the project in that organization: the list row carries the organization and the owner's role, the organization's record its slug; the same call again is the same project", async () => {
  const slug = freshDnsSafeProjectSlug("org-project");
  const api = person(`${slug}@example.com`);
  const org = await api.organizations.create({ name: `Organization ${slug}` });
  using project = await api.projects.create({ project: slug, orgId: org.id });
  const { projectId, projectSlug } = await project.whoami();
  expect(projectId).toMatch(/^prj_[0-9a-f]{32}$/);
  expect(projectSlug).toBe(slug);
  // the catalog: the project's row with its organization and the reader's role; the organization's count
  expect(await api.projects.list()).toContainEqual({
    id: projectId,
    slug,
    orgId: org.id,
    role: "owner",
  });
  expect(await api.organizations.list()).toContainEqual({ ...org, projects: 1 });
  // the organization's record: `organization/project-added` folded on it before the answer
  using organization = await api.organizations.get(org.id);
  expect((await record(organization)).projects?.[projectId]).toEqual({
    slug,
    createdAt: expect.any(String),
  });
  // the same organization's same slug is the same project (a new request, the same answer)
  using again = await api.projects.create({ project: slug, orgId: org.id });
  expect(await again.whoami()).toMatchObject({ projectId });
  expect(
    (await api.projects.list()).filter((row: { slug: string }) => row.slug === slug),
  ).toHaveLength(1);
});

test("a slug another organization holds is refused: a second person's projects.create with the same name is PROJECT_NAME_TAKEN, and mints no project", async () => {
  const slug = freshDnsSafeProjectSlug("org-taken");
  const owner = person(`${slug}@example.com`);
  using project = await owner.projects.create({ project: slug });
  const { projectId } = await project.whoami();
  const other = person(`${slug}-other@example.com`);
  // the answer is the control plane's failure terminal, rethrown with the saga's code (the drain is
  // serial across every file's requests, so the bound is wider than a refusal answered at once)
  const refused = await rejection(
    other.projects.create({ project: slug }),
    "a second organization's same slug",
    30_000,
  );
  expect(errorCode(refused)).toBe("PROJECT_NAME_TAKEN");
  expect(refused.message).toMatch(/already taken/);
  // a refused request makes nothing on the way: no project, and not even the person's first
  // organization (the slug is checked before one is made)
  expect(await other.projects.list()).toEqual([]);
  expect(await other.organizations.list()).toEqual([]);
  // the holder's is untouched
  expect((await owner.projects.list()).map((row: { id: string }) => row.id)).toEqual([projectId]);
});

test("organizations.rename answers the new name and the record follows; delete is refused while the organization holds a project; an empty organization goes — off the list and off the owner's account", async () => {
  const slug = freshDnsSafeProjectSlug("org-rename-delete");
  const api = person(`${slug}@example.com`);
  const org = await api.organizations.create({ name: `Organization ${slug}` });
  using project = await api.projects.create({ project: slug, orgId: org.id });
  expect(await project.whoami()).toMatchObject({ projectSlug: slug });
  // rename: the answer, the record, the list
  const renamed = `Renamed ${slug}`;
  expect(await api.organizations.rename(org.id, { name: `  ${renamed}  ` })).toEqual({
    id: org.id,
    name: renamed, // trimmed, as the saga spells it
    role: "owner",
    projects: 1,
  });
  // the record follows at once — and no earlier fact of the same person lands after it (the
  // creation, answered before, once overtook the rename on a cold context and kept the old name)
  using organization = await api.organizations.get(org.id);
  expect(await record(organization)).toMatchObject({ name: renamed });
  expect(
    (await api.organizations.list()).find((row: { id: string }) => row.id === org.id)?.name,
  ).toBe(renamed);
  // delete: refused while a project is held (a project is its organization's; nothing deletes one)
  const refused = await rejection(
    api.organizations.delete(org.id),
    "deleting an organization that holds a project",
    30_000,
  );
  expect(errorCode(refused)).toBe("INVALID_INPUT");
  expect(refused.message).toMatch(/still holds 1 project/);
  expect((await api.organizations.list()).map((row: { id: string }) => row.id)).toContain(org.id);
  // an empty organization goes: the row, and the membership off the owner's account
  const empty = await api.organizations.create({ name: `Empty ${slug}` });
  expect((await memberships(api))[empty.id]).toBeDefined();
  await api.organizations.delete(empty.id);
  expect((await api.organizations.list()).map((row: { id: string }) => row.id)).toEqual([org.id]);
  expect((await memberships(api))[empty.id]).toBeUndefined();
  // the deleted organization's context is no longer the person's to hold
  expect(
    errorCode(await rejection(api.organizations.get(empty.id).whoami(), "a deleted org")),
  ).toBe("FORBIDDEN");
});

test("organizations.addMember gives a second person the organization — their list, their account, the organization's projects — as a member, not an owner; removeMember takes it back; the last owner cannot be removed", async () => {
  const slug = freshDnsSafeProjectSlug("org-members");
  const owner = person(`${slug}@example.com`);
  const guest = person(`${slug}-guest@example.com`);
  const [{ actor: ownerId }, { actor: guestId }] = await Promise.all([
    owner.whoami(),
    guest.whoami(),
  ]);
  const org = await owner.organizations.create({ name: `Organization ${slug}` });
  using project = await owner.projects.create({ project: slug, orgId: org.id });
  const { projectId } = await project.whoami();
  // before: the guest reaches nothing of it (the reach is re-read once before a refusal)
  expect(errorCode(await rejection(guest.projects.get(projectId).whoami(), "a stranger"))).toBe(
    "FORBIDDEN",
  );
  await owner.organizations.addMember(org.id, { userId: guestId, role: "member" });
  // THE GUEST SEES IT: the catalog through their memberships, their account's fold, the project
  expect(
    await until(
      "the organization on the guest's list",
      async () =>
        (await guest.organizations.list()).find((row: { id: string }) => row.id === org.id),
      REACH_MEMO_BOUND_MS,
    ),
  ).toEqual({ id: org.id, name: `Organization ${slug}`, role: "member", projects: 1 });
  expect((await memberships(guest))[org.id]).toEqual({
    role: "member",
    since: expect.any(String),
  });
  expect(
    await until(
      "the project on the guest's list",
      async () => (await guest.projects.list()).find((row: { id: string }) => row.id === projectId),
      REACH_MEMO_BOUND_MS,
    ),
  ).toEqual({ id: projectId, slug, orgId: org.id, role: "member" });
  expect(await guest.projects.get(projectId).whoami()).toMatchObject({ projectId });
  // … and the organization's record has both
  using organization = await owner.organizations.get(org.id);
  const { members: both } = await record(organization);
  expect(both).toEqual({
    [ownerId]: { role: "owner", since: expect.any(String) },
    [guestId]: { role: "member", since: expect.any(String) },
  });
  // a member reaches; only an owner runs the organization
  expect(
    errorCode(
      await rejection(
        guest.organizations.rename(org.id, { name: "Not the guest's to rename" }),
        "a member renaming",
        30_000,
      ),
    ),
  ).toBe("FORBIDDEN");
  // REMOVE: the guest's list, account and reach all lose it
  await owner.organizations.removeMember(org.id, { userId: guestId });
  expect((await memberships(guest))[org.id]).toBeUndefined();
  await until(
    "the organization off the guest's list",
    async () =>
      !(await guest.organizations.list()).some((row: { id: string }) => row.id === org.id),
    REACH_MEMO_BOUND_MS,
  );
  await until(
    "the project off the guest's list",
    async () => !(await guest.projects.list()).some((row: { id: string }) => row.id === projectId),
    REACH_MEMO_BOUND_MS,
  );
  await until(
    "the guest no longer reaches the project",
    async () =>
      errorCode(await rejection(guest.projects.get(projectId).whoami(), "the removed guest")) ===
      "FORBIDDEN",
    REACH_MEMO_BOUND_MS,
  );
  const { members: ownerAlone } = await record(organization);
  expect(ownerAlone).toEqual({ [ownerId]: { role: "owner", since: expect.any(String) } });
  // THE LAST OWNER stays: an organization keeps at least one
  const refused = await rejection(
    owner.organizations.removeMember(org.id, { userId: ownerId }),
    "removing the only owner",
    30_000,
  );
  expect(errorCode(refused)).toBe("INVALID_INPUT");
  expect(refused.message).toMatch(/at least one owner/);
  expect((await memberships(owner))[org.id]).toEqual({ role: "owner", since: expect.any(String) });
});

test("organizations.createInvitation hands an owner a single-use link: a second person previews it, accepts it, and lists the organization as a member; a third person is refused; the record's pending link goes with the acceptance", async () => {
  const slug = freshDnsSafeProjectSlug("org-invite");
  const owner = person(`${slug}@example.com`);
  const guest = person(`${slug}-guest@example.com`);
  const late = person(`${slug}-late@example.com`);
  const [{ actor: ownerId }, { actor: guestId }] = await Promise.all([
    owner.whoami(),
    guest.whoami(),
  ]);
  const name = `Organization ${slug}`;
  const org = await owner.organizations.create({ name });
  const invitation = await owner.organizations.createInvitation(org.id, {
    emailHint: `${slug}-guest@example.com`,
  });
  expect(invitation).toEqual({
    id: expect.stringMatching(/^inv_[0-9a-f]{32}$/),
    orgId: org.id,
    role: "member",
    emailHint: `${slug}-guest@example.com`,
    expiresAt: expect.any(String),
    token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  // the owner's record lists it as pending the moment the verb answers — the link's secret is
  // nowhere in it
  using organization = await owner.organizations.get(org.id);
  expect((await record(organization)).invitations[invitation.id]).toEqual({
    role: "member",
    emailHint: `${slug}-guest@example.com`,
    expiresAt: invitation.expiresAt,
    createdAt: expect.any(String),
  });
  expect(JSON.stringify(await record(organization))).not.toContain(invitation.token);
  // a member cannot mint one; neither can a stranger
  expect(
    errorCode(
      await rejection(guest.organizations.createInvitation(org.id), "a stranger inviting", 30_000),
    ),
  ).toBe("FORBIDDEN");
  // THE GUEST holding the link sees what it opens, before joining
  expect(await guest.organizations.invitation(invitation.token)).toEqual({
    id: invitation.id,
    orgId: org.id,
    orgName: name,
    role: "member",
    emailHint: `${slug}-guest@example.com`,
    expiresAt: invitation.expiresAt,
    status: "pending",
    member: false,
    acceptedByYou: false,
  });
  expect(await guest.organizations.invitation(`${invitation.token}x`)).toBeNull();
  // … accepts it, and lists the organization at once — the answer is the row they now read
  const joined = { id: org.id, name, role: "member", projects: 0 };
  expect(await guest.organizations.acceptInvitation(invitation.token)).toEqual(joined);
  expect(await guest.organizations.acceptInvitation(invitation.token)).toEqual(joined);
  expect(
    (await guest.organizations.list()).find((row: { id: string }) => row.id === org.id),
  ).toEqual(joined);
  // both folds hold it by the time accept answers: the guest's account, and the record — the guest
  // a member, the link no longer pending
  expect((await memberships(guest))[org.id]).toEqual({
    role: "member",
    since: expect.any(String),
  });
  const joinedRecord = await record(organization);
  expect(joinedRecord).toMatchObject({
    members: {
      [ownerId]: { role: "owner", since: expect.any(String) },
      [guestId]: { role: "member", since: expect.any(String) },
    },
  });
  expect(Object.keys(joinedRecord.invitations)).toEqual([]);
  // SINGLE USE: a third person is refused and joins nothing
  expect((await late.organizations.invitation(invitation.token))?.status).toBe("accepted");
  const refused = await rejection(
    late.organizations.acceptInvitation(invitation.token),
    "a second person reusing the link",
    30_000,
  );
  expect(errorCode(refused)).toBe("INVALID_INPUT");
  expect(refused.message).toMatch(/already used/);
  expect(await late.organizations.list()).toEqual([]);
  // a revoked link opens nothing
  const withdrawn = await owner.organizations.createInvitation(org.id, { role: "owner" });
  expect((await record(organization)).invitations).toHaveProperty(withdrawn.id);
  await owner.organizations.revokeInvitation(org.id, { invitationId: withdrawn.id });
  expect(Object.keys((await record(organization)).invitations)).toEqual([]);
  expect((await late.organizations.invitation(withdrawn.token))?.status).toBe("revoked");
  expect(
    errorCode(
      await rejection(
        late.organizations.acceptInvitation(withdrawn.token),
        "accepting a revoked link",
        30_000,
      ),
    ),
  ).toBe("INVALID_INPUT");
});

test("a person's first projects.create without orgId makes their organization — named after the email's local part, them its owner — and lands the project in it; their next lands in the same one", async () => {
  const slug = freshDnsSafeProjectSlug("org-first");
  const api = person(`${slug}@example.com`);
  using project = await api.projects.create({ project: slug });
  const { projectId } = await project.whoami();
  // ONE organization, made on first use: the local part is its name, the person its owner
  const orgs = await api.organizations.list();
  expect(orgs).toEqual([
    { id: expect.stringMatching(/^org_[0-9a-f]{32}$/), name: slug, role: "owner", projects: 1 },
  ]);
  const [org] = orgs;
  expect(await api.projects.list()).toEqual([
    { id: projectId, slug, orgId: org.id, role: "owner" },
  ]);
  // the one fold this row polls: the minted organization's membership reaches the person's account
  // in the background, so the creation never waits on the account (src/session.ts
  // `landProjectOnOrganization`)
  expect(
    await until(
      "the membership lands on the account",
      async () => (await memberships(api))[org.id],
    ),
  ).toEqual({ role: "owner", since: expect.any(String) });
  // the next project without orgId goes to the same organization — no second one is minted
  using second = await api.projects.create({ project: `${slug}-2` });
  const { projectId: secondId } = await second.whoami();
  expect(secondId).not.toBe(projectId);
  expect(await api.organizations.list()).toEqual([{ ...org, projects: 2 }]);
  expect(
    (await api.projects.list())
      .map((row: { id: string; orgId: string }) => [row.id, row.orgId])
      .sort(),
  ).toEqual(
    [
      [projectId, org.id],
      [secondId, org.id],
    ].sort(),
  );
});

/** A signed-in person: the admin fixture acting `as` them (src/session.ts finds-or-creates the user
 *  in the control plane, and the session carries `organizations:write`). */
const person = (email: string) => session().authenticate(adminCredentials({ email }));

/** A person's `memberships` fold, off their account facet — `{ [orgId]: { role, since } }`. */
const memberships = async (api: any) =>
  (await api.user.facets.get("account").liveSnapshot()).state.memberships ?? {};

/** An organization's record, off its `organization` facet. */
const record = async (organization: any) =>
  (await organization.facets.get("organization").liveSnapshot()).state;
