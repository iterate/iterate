// e2e/organizations.e2e.test.ts — THE CONTROL PLANE through a person's session: every verb on
// `session.organizations` (and `projects.create` in an organization) is one call on the control
// plane (src/control-plane/), whose catalog every read answers as it stands — `organizations.list`,
// `members`, `invitations` and `projects.list`, what the dash reads — so these rows read it at once,
// never by polling; only another person's reach of a project waits, on the edge's memo. Each verb
// then lands its facts, the organization's ACTIVITY, on the organization's own context and a
// member's account in the background (src/session.ts `publishOrganizationFacts`), which the rows
// that read it poll for. Every row mints its own person, organization and project; the files run
// in parallel.
import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import { adminCredentials, rejection, session, until } from "./support/client.ts";
import { freshDnsSafeProjectSlug } from "./support/project-host.ts";

/** A person's reach of a project as the edge memoizes it (src/control-plane/edge.ts, five seconds):
 *  a request drops the memo on the isolate it was made on, so ANOTHER person's socket — possibly
 *  on another isolate of a deployed worker — may admit from a memo up to five seconds old. */
const REACH_MEMO_BOUND_MS = 20_000;

test("organizations.create({ name }) answers the owner's row, which every read holds at once; its activity lands on the organization's own context and the owner's account", async () => {
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
  expect(await membersOf(api, org.id)).toEqual({
    [userId]: { email: `${slug}@example.com`, role: "owner", createdAt: expect.any(Number) },
  });
  expect(await api.organizations.invitations(org.id)).toEqual([]);
  // THE ACTIVITY: the context a member holds by identity, and the owner's account
  using organization = await api.organizations.get(org.id);
  expect(
    (await activity(organization, 2)).map(({ type, payload }: StreamFact) => ({ type, payload })),
  ).toEqual([
    { type: "events.iterate.com/organization/created", payload: { name } },
    {
      type: "events.iterate.com/organization/member-added",
      payload: { orgId: org.id, userId, role: "owner" },
    },
  ]);
  expect((await activity(api.user, 1)).map(({ payload }: StreamFact) => payload)).toEqual([
    { orgId: org.id, userId, role: "owner" },
  ]);
});

test("projects.create({ project, orgId }) lands the project in that organization: the list row carries the organization and the owner's role; the same call again is the same project", async () => {
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

test("organizations.rename answers the new name and the list follows at once; delete is refused while the organization holds a project; an empty organization goes, off the list", async () => {
  const slug = freshDnsSafeProjectSlug("org-rename-delete");
  const api = person(`${slug}@example.com`);
  const org = await api.organizations.create({ name: `Organization ${slug}` });
  using project = await api.projects.create({ project: slug, orgId: org.id });
  expect(await project.whoami()).toMatchObject({ projectSlug: slug });
  // rename: the answer, the list
  const renamed = `Renamed ${slug}`;
  expect(await api.organizations.rename(org.id, { name: `  ${renamed}  ` })).toEqual({
    id: org.id,
    name: renamed, // trimmed, as the saga spells it
    role: "owner",
    projects: 1,
  });
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
  // an empty organization goes, and its members with it
  const empty = await api.organizations.create({ name: `Empty ${slug}` });
  await api.organizations.delete(empty.id);
  expect((await api.organizations.list()).map((row: { id: string }) => row.id)).toEqual([org.id]);
  // the deleted organization's context is no longer the person's to hold
  expect(
    errorCode(await rejection(api.organizations.get(empty.id).whoami(), "a deleted org")),
  ).toBe("FORBIDDEN");
});

test("organizations.addMember gives a second person the organization — their list, its members, its projects — as a member, not an owner; removeMember takes it back; the last owner cannot be removed", async () => {
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
  // THE GUEST SEES IT at once: the lists are read past every memo
  expect(
    (await guest.organizations.list()).find((row: { id: string }) => row.id === org.id),
  ).toEqual({ id: org.id, name: `Organization ${slug}`, role: "member", projects: 1 });
  expect((await guest.projects.list()).find((row: { id: string }) => row.id === projectId)).toEqual(
    { id: projectId, slug, orgId: org.id, role: "member" },
  );
  expect(await guest.projects.get(projectId).whoami()).toMatchObject({ projectId });
  // … and the members, which a member reads too
  const createdAt = expect.any(Number);
  const ownerAlone = { [ownerId]: { email: `${slug}@example.com`, role: "owner", createdAt } };
  const both = {
    ...ownerAlone,
    [guestId]: { email: `${slug}-guest@example.com`, role: "member", createdAt },
  };
  expect(await membersOf(owner, org.id)).toEqual(both);
  expect(await membersOf(guest, org.id)).toEqual(both);
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
  // REMOVE: the guest's lists lose it at once, their reach within the memo
  await owner.organizations.removeMember(org.id, { userId: guestId });
  expect((await guest.organizations.list()).some((row: { id: string }) => row.id === org.id)).toBe(
    false,
  );
  expect((await guest.projects.list()).some((row: { id: string }) => row.id === projectId)).toBe(
    false,
  );
  await until(
    "the guest no longer reaches the project",
    async () =>
      errorCode(await rejection(guest.projects.get(projectId).whoami(), "the removed guest")) ===
      "FORBIDDEN",
    REACH_MEMO_BOUND_MS,
  );
  expect(await membersOf(owner, org.id)).toEqual(ownerAlone);
  // THE LAST OWNER stays: an organization keeps at least one
  const refused = await rejection(
    owner.organizations.removeMember(org.id, { userId: ownerId }),
    "removing the only owner",
    30_000,
  );
  expect(errorCode(refused)).toBe("INVALID_INPUT");
  expect(refused.message).toMatch(/at least one owner/);
  expect(await membersOf(owner, org.id)).toEqual(ownerAlone);
});

test("organizations.createInvitation hands an owner a single-use link: a second person previews it, accepts it, and lists the organization as a member; a third person is refused; the owner's open links lose it with the acceptance", async () => {
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
  // the owner's open links hold it the moment the verb answers — the link's secret is not in them
  const { token: _token, ...open } = invitation;
  expect(await owner.organizations.invitations(org.id)).toEqual([open]);
  // a stranger can neither mint one nor list them
  expect(
    errorCode(
      await rejection(guest.organizations.createInvitation(org.id), "a stranger inviting", 30_000),
    ),
  ).toBe("FORBIDDEN");
  expect(
    errorCode(await rejection(guest.organizations.invitations(org.id), "a stranger listing")),
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
  // the guest a member, the link no longer open — and a member lists no links, an owner's alone
  const createdAt = expect.any(Number);
  expect(await membersOf(owner, org.id)).toEqual({
    [ownerId]: { email: `${slug}@example.com`, role: "owner", createdAt },
    [guestId]: { email: `${slug}-guest@example.com`, role: "member", createdAt },
  });
  // in the order they joined: by email, the guest's `<slug>-guest@` would sort first
  expect(
    (await owner.organizations.members(org.id)).map(({ userId }: { userId: string }) => userId),
  ).toEqual([ownerId, guestId]);
  expect(await owner.organizations.invitations(org.id)).toEqual([]);
  expect(
    errorCode(await rejection(guest.organizations.invitations(org.id), "a member listing")),
  ).toBe("FORBIDDEN");
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
  expect(
    (await owner.organizations.invitations(org.id)).map(({ id }: { id: string }) => id),
  ).toEqual([withdrawn.id]);
  await owner.organizations.revokeInvitation(org.id, { invitationId: withdrawn.id });
  expect(await owner.organizations.invitations(org.id)).toEqual([]);
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
  // the minted organization's activity: its creation, its owner and the project, in that order
  using organization = await api.organizations.get(org.id);
  expect((await activity(organization, 3)).map(({ type }: StreamFact) => type)).toEqual([
    "events.iterate.com/organization/created",
    "events.iterate.com/organization/member-added",
    "events.iterate.com/organization/project-added",
  ]);
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

type StreamFact = { type: string; payload: unknown };

/** An organization's members, by user id. */
const membersOf = async (api: any, orgId: string) =>
  Object.fromEntries(
    (await api.organizations.members(orgId)).map(
      ({ userId, ...member }: { userId: string; email: string; role: string }) => [userId, member],
    ),
  );

/** A context's `events.iterate.com/organization/…` facts — an organization's activity, or a
 *  person's memberships on their account — once at least `count` have landed: a verb publishes
 *  them in the background. */
const activity = (context: any, count: number): Promise<StreamFact[]> =>
  until(`${count} organization facts land`, async () => {
    const { events } = await context.readEvents(0, 1000);
    const facts = events.filter((event: StreamFact) =>
      event.type.startsWith("events.iterate.com/organization/"),
    );
    return facts.length >= count && facts;
  });
