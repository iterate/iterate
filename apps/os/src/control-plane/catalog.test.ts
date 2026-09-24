// src/control-plane/catalog.test.ts — the control-plane database's executable spec, in node: every
// write over node:sqlite (standing in for the DO's SQLite), what it answers, what it refuses, read
// back off the tables. Delivery of the entity streams' activity and a project's own creation saga are
// the session's (session.ts), proven on the worker (__workers-tests__/control-plane.test.ts,
// e2e/organizations.e2e.test.ts).
import { expect, test } from "vitest";
import { nodeSqliteDurableObjectStorage } from "../stream/test-support.ts";
import { ADMIN_ORG_ID, type Caller, ControlPlaneDatabase, projectSlug } from "./catalog.ts";

const admin: Caller = { principal: { actor: "admin" } };

test("people: find-or-create by email, one spelling of an address", () => {
  const { c } = catalog();
  const ada = c.createUser({ email: " Ada@Example.com " });
  expect(ada).toEqual({
    id: expect.stringMatching(/^user_[0-9a-f]{32}$/),
    email: "ada@example.com",
  });
  expect(c.createUser({ email: "ADA@example.com" })).toEqual(ada);
  expect(c.user("ada@example.com")).toEqual(ada);
});

test("people: an identity links once by verified email, then by subject: a changed email follows it unless another person holds it; one subject per provider", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const bob = person("bob@example.com");
  // the Google subject adopts the person the email names
  expect(c.linkIdentity({ provider: "google", subject: "g-ada", email: ada.email })).toEqual(ada);
  // … and follows them to a new address
  expect(
    c.linkIdentity({ provider: "google", subject: "g-ada", email: "ada2@example.com" }),
  ).toEqual({ id: ada.id, email: "ada2@example.com" });
  expect(c.identity("google", "g-ada")).toEqual({ id: ada.id, email: "ada2@example.com" });
  // not onto an address another person holds
  expect(
    refusal(() => c.linkIdentity({ provider: "google", subject: "g-ada", email: bob.email })),
  ).toMatchObject({ code: "IDENTITY_CONFLICT" });
  // a second Google subject cannot adopt the linked person; a Cloudflare one can
  expect(
    refusal(() =>
      c.linkIdentity({
        provider: "google",
        subject: "g-other",
        email: "ada2@example.com",
      }),
    ),
  ).toMatchObject({ code: "IDENTITY_CONFLICT" });
  expect(
    c.linkIdentity({
      provider: "cloudflare",
      subject: "cf-ada",
      email: "ada2@example.com",
    }),
  ).toMatchObject({ id: ada.id });
  // a subject nobody has seen, with a new email, is a new person
  const carol = c.linkIdentity({
    provider: "google",
    subject: "g-carol",
    email: "carol@example.com",
  });
  expect(c.identity("google", "g-carol")).toEqual(carol);
  expect(carol).not.toMatchObject({ id: ada.id });
});

test("organizations: created with the caller its owner: the record, the membership, and what the owner can access", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const org = c.createOrganization(as(ada), { name: "  Booper " });
  expect(org).toEqual({
    id: expect.stringMatching(/^org_[0-9a-f]{32}$/),
    name: "Booper",
    role: "owner",
    projects: 0,
  });
  expect(c.organization(org.id)).toEqual({ id: org.id, name: "Booper", projects: 0 });
  expect(c.members(org.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
  expect(c.accessibleTo(ada.id)).toEqual({ organizations: [org], projects: [] });
});

test("organizations: the operator alone names an owner — one who exists", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const bob = person("bob@example.com");
  expect(
    refusal(() => c.createOrganization(as(ada), { name: "X", ownerId: bob.id })),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(
    refusal(() => c.createOrganization(admin, { name: "X", ownerId: "user_nobody" })).message,
  ).toMatch(/No user/);
  const named = c.createOrganization(admin, { name: "Named", ownerId: ada.id });
  expect(named).toEqual({ id: expect.stringMatching(/^org_/), name: "Named", projects: 0 });
  expect(c.members(named.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
  // an owner named by email is held by id
  const byEmail = c.createOrganization(admin, { name: "By email", ownerId: ada.email });
  expect(c.members(byEmail.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
});

test("organizations: an owner renames, adds and removes members; the last owner stays; a stranger is refused", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const bob = person("bob@example.com");
  const org = c.createOrganization(as(ada), { name: "Booper" });
  expect(refusal(() => c.renameOrganization(as(bob), org.id, "Mine"))).toMatchObject({
    code: "FORBIDDEN",
  });
  expect(c.renameOrganization(as(ada), org.id, "Booper Inc")).toMatchObject({ name: "Booper Inc" });
  expect(
    refusal(() => c.addMember(as(ada), org.id, { userId: "user_nobody", role: "member" })).message,
  ).toMatch(/No user/);
  c.addMember(as(ada), org.id, { userId: bob.email, role: "member" }); // by email, held by id
  c.addMember(as(ada), org.id, { userId: bob.id, role: "member" }); // the same again is a no-op
  expect(c.accessibleTo(bob.id)).toMatchObject({
    organizations: [{ id: org.id, name: "Booper Inc", role: "member", projects: 0 }],
  });
  expect(refusal(() => c.removeMember(as(ada), org.id, { userId: ada.id }))).toMatchObject({
    message: "An organization keeps at least one owner.",
  });
  // nor demoted
  expect(
    refusal(() => c.addMember(as(ada), org.id, { userId: ada.id, role: "member" })),
  ).toMatchObject({ message: "An organization keeps at least one owner." });
  c.removeMember(as(ada), org.id, { userId: bob.email }); // by email, as added
  expect(c.accessibleTo(bob.id)).toMatchObject({ organizations: [] });
});

test("organizations: deleted only while it holds no project; then it and its memberships are gone", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const bob = person("bob@example.com");
  const org = c.createOrganization(as(ada), { name: "Booper" });
  c.addMember(as(ada), org.id, { userId: bob.id, role: "member" });
  c.createProject(as(ada), { project: "dawg", organizationId: org.id });
  expect(refusal(() => c.deleteOrganization(as(ada), org.id)).message).toMatch(
    /still holds 1 project/,
  );
  const empty = c.createOrganization(as(ada), { name: "Empty" });
  c.addMember(as(ada), empty.id, { userId: bob.id, role: "member" });
  c.deleteOrganization(as(ada), empty.id);
  expect(c.organization(empty.id)).toBeNull();
  expect(c.accessibleTo(bob.id).organizations.map(({ id }) => id)).toEqual([org.id]);
});

test("projects: a slug is one project across every organization: the same organization's again is the same project, another's is refused before anything is made", () => {
  const { c, person } = catalog();
  const ada = person("ada@example.com");
  const bob = person("bob@example.com");
  const org = c.createOrganization(as(ada), { name: "Booper" });
  const dawg = c.createProject(as(ada), { project: "Dawg!", organizationId: org.id });
  expect(dawg).toEqual({
    id: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    slug: "dawg",
    orgId: org.id,
  });
  expect(c.project("dawg")).toEqual(dawg);
  expect(c.accessibleTo(ada.id)).toMatchObject({ projects: [{ ...dawg, role: "owner" }] });
  // asking again is the same project
  expect(c.createProject(as(ada), { project: "dawg" })).toEqual(dawg);
  // Bob has no organization yet: the refusal makes none
  expect(refusal(() => c.createProject(as(bob), { project: "dawg" }))).toMatchObject({
    code: "PROJECT_NAME_TAKEN",
  });
  expect(
    refusal(() => c.createProject(as(bob), { project: "x", organizationId: org.id })),
  ).toMatchObject({ code: "FORBIDDEN" });
  expect(c.accessibleTo(bob.id)).toEqual({ organizations: [], projects: [] });
});

test("projects: with no organization named: the person's first by name, made on first use after their email; the operator's own organization, made on first use", () => {
  const { c, person } = catalog();
  const ada = person("ada.lovelace@example.com");
  const first = c.createProject(as(ada), { project: "one" });
  const [org] = c.accessibleTo(ada.id).organizations;
  expect(org).toEqual({ id: first.orgId, name: "ada.lovelace", role: "owner", projects: 1 });
  expect(c.createProject(as(ada), { project: "two" })).toMatchObject({ orgId: first.orgId });
  expect(c.createProject(admin, { project: "ops", restoreProjectId: "prj_ops" })).toEqual({
    id: "prj_ops",
    slug: "ops",
    orgId: ADMIN_ORG_ID,
  });
  expect(c.organization(ADMIN_ORG_ID)).toEqual({ id: ADMIN_ORG_ID, name: "admin", projects: 1 });
  expect(c.members(ADMIN_ORG_ID)).toEqual([]);
  expect(
    refusal(() => c.createProject(as(ada), { project: "x", restoreProjectId: "prj_x" })),
  ).toMatchObject({ code: "FORBIDDEN" });
});

test("projects: the operator restores a project under its archived id: the same archive again is the same project; a slug or an id bound elsewhere is refused", () => {
  const { c } = catalog();
  const restore = (project: string, restoreProjectId: string) =>
    c.createProject(admin, { project, restoreProjectId });
  expect(restore("garple", "prj_garple")).toEqual({
    id: "prj_garple",
    slug: "garple",
    orgId: ADMIN_ORG_ID,
  });
  expect(restore("garple", "prj_garple")).toMatchObject({ id: "prj_garple" });
  expect(refusal(() => restore("garple", "prj_other"))).toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: expect.stringMatching(/not the restored id/),
  });
  expect(refusal(() => restore("elsewhere", "prj_garple"))).toMatchObject({
    code: "IDENTITY_CONFLICT",
    message: expect.stringMatching(/already belongs/),
  });
  expect(refusal(() => restore("empty", ""))).toMatchObject({ code: "INVALID_INPUT" });
});

test.for([
  ["Booper", "booper"],
  ["  My Project! v2 ", "my-project-v2"],
  ["--dawg--", "dawg"],
  ["!!!", ""],
] as const)("projects: projectSlug(%j) is %j", ([name, slug]) => {
  expect(projectSlug(name)).toBe(slug);
});

const as = (user: { id: string; email: string }): Caller => ({
  principal: { actor: user.id, email: user.email },
});

function catalog() {
  const c = new ControlPlaneDatabase(nodeSqliteDurableObjectStorage().sql);
  return { c, person: (email: string) => c.createUser({ email }) };
}

const refusal = (thunk: () => unknown) => {
  try {
    thunk();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
};
