// src/control-plane/catalog.test.ts — the catalog's executable spec, in node: every write over
// node:sqlite (standing in for the facet's SQLite), what it answers, what it refuses, and the facts
// it owes — read back off the outbox as `{ path, type, payload }`. The delivery of those facts and
// the project's own creation are the facet's (durable-object.ts), proven on the worker
// (__workers-tests__/control-plane.test.ts, e2e/organizations.e2e.test.ts).
import { describe, expect, test } from "vitest";
import { nodeSqliteDurableObjectStorage } from "../stream/test-support.ts";
import { ADMIN_ORG_ID, type Asker, Catalog, projectSlug } from "./catalog.ts";

const admin: Asker = { principal: { actor: "admin" } };
const nobody: Asker = { principal: null };
const as = (user: { id: string; email: string }): Asker => ({
  principal: { actor: user.id, email: user.email },
});

function catalog() {
  const c = new Catalog(nodeSqliteDurableObjectStorage().sql);
  /** The facts owed since the last call, by context and type — and marked delivered. */
  const owed = () => {
    const rows = c.owed(0).flatMap((context) => c.outbox(context));
    c.delivered(rows.map((row) => row.id));
    return rows
      .sort((a, b) => a.id - b.id)
      .map((row) => {
        const { type, payload } = JSON.parse(row.event) as { type: string; payload: unknown };
        // a project's root by `<id>:/`, the global namespace's contexts by their path
        const path = row.projectId === "global" ? row.path : `${row.projectId}:${row.path}`;
        return { path, type: type.replace("events.iterate.com/", ""), payload };
      });
  };
  return { c, owed, person: (email: string) => c.createUser(nobody, { email }) };
}

const refusal = (thunk: () => unknown) => {
  try {
    thunk();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
};

describe("people", () => {
  test("find-or-create by email, one spelling of an address; the operator alone pins an id", () => {
    const { c, owed } = catalog();
    const ada = c.createUser(nobody, { email: " Ada@Example.com " });
    expect(ada).toEqual({
      id: expect.stringMatching(/^user_[0-9a-f]{32}$/),
      email: "ada@example.com",
    });
    expect(c.createUser(nobody, { email: "ADA@example.com" })).toEqual(ada);
    expect(owed()).toEqual([
      {
        path: "/",
        type: "control-plane/user-created",
        payload: { userId: ada.id, email: ada.email },
      },
    ]);
    expect(refusal(() => c.createUser(as(ada), { email: "x@example.com", id: "user_x" }))).toEqual({
      code: "FORBIDDEN",
      message: "Only the operator may pin a user's id.",
    });
    expect(c.createUser(admin, { email: "pinned@example.com", id: "user_pinned" }).id).toBe(
      "user_pinned",
    );
  });

  test("an identity links once by verified email, then by subject: a changed email follows it unless another person holds it; one subject per provider", () => {
    const { c, owed, person } = catalog();
    const ada = person("ada@example.com");
    const bob = person("bob@example.com");
    owed();
    // the Google subject adopts the person the email names
    expect(
      c.linkIdentity(nobody, { provider: "google", subject: "g-ada", email: ada.email }),
    ).toEqual(ada);
    // … and follows them to a new address
    expect(
      c.linkIdentity(nobody, { provider: "google", subject: "g-ada", email: "ada2@example.com" }),
    ).toEqual({ id: ada.id, email: "ada2@example.com" });
    expect(owed().map(({ type }) => type)).toEqual([
      "control-plane/identity-linked",
      "control-plane/user-email-changed",
    ]);
    // not onto an address another person holds
    expect(
      refusal(() =>
        c.linkIdentity(nobody, { provider: "google", subject: "g-ada", email: bob.email }),
      ).code,
    ).toBe("IDENTITY_CONFLICT");
    // a second Google subject cannot adopt the linked person; a Cloudflare one can
    expect(
      refusal(() =>
        c.linkIdentity(nobody, {
          provider: "google",
          subject: "g-other",
          email: "ada2@example.com",
        }),
      ).code,
    ).toBe("IDENTITY_CONFLICT");
    expect(
      c.linkIdentity(nobody, {
        provider: "cloudflare",
        subject: "cf-ada",
        email: "ada2@example.com",
      }).id,
    ).toBe(ada.id);
    // a subject nobody has seen, with a new email, is a new person
    const carol = c.linkIdentity(nobody, {
      provider: "google",
      subject: "g-carol",
      email: "carol@example.com",
    });
    expect(c.identity("google", "g-carol")).toEqual(carol);
    expect(carol.id).not.toBe(ada.id);
  });
});

describe("organizations", () => {
  test("created with the asker its owner: the record and the membership land on the organization, the membership on the account, the write on the root", () => {
    const { c, owed, person } = catalog();
    const ada = person("ada@example.com");
    owed();
    const org = c.createOrganization(as(ada), { name: "  Booper " });
    expect(org).toEqual({
      id: expect.stringMatching(/^org_[0-9a-f]{32}$/),
      name: "Booper",
      role: "owner",
      projects: 0,
    });
    const membership = { orgId: org.id, userId: ada.id, role: "owner" };
    expect(owed()).toEqual([
      {
        path: `/organizations/${org.id}`,
        type: "organization/created",
        payload: { name: "Booper" },
      },
      {
        path: "/",
        type: "control-plane/organization-created",
        payload: { orgId: org.id, name: "Booper", ownerId: ada.id },
      },
      { path: `/organizations/${org.id}`, type: "organization/member-added", payload: membership },
      { path: `/users/${ada.id}`, type: "organization/member-added", payload: membership },
      { path: "/", type: "control-plane/member-added", payload: membership },
    ]);
    expect(c.reach(ada.id)).toEqual({ orgs: [org], projects: [] });
  });

  test("the operator alone pins an id or names an owner — one who exists; a pinned organization that exists is answered as it is", () => {
    const { c, person } = catalog();
    const ada = person("ada@example.com");
    expect(refusal(() => c.createOrganization(as(ada), { name: "X", id: "org_x" })).code).toBe(
      "FORBIDDEN",
    );
    expect(
      refusal(() => c.createOrganization(admin, { name: "X", ownerId: "user_nobody" })).message,
    ).toMatch(/No user/);
    const pinned = { name: "Pinned", id: "org_pinned", ownerId: ada.id };
    expect(c.createOrganization(admin, pinned)).toEqual({
      id: "org_pinned",
      name: "Pinned",
      projects: 0,
    });
    expect(c.createOrganization(admin, { ...pinned, name: "Renamed?" }).name).toBe("Pinned");
    expect(c.members("org_pinned")).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
    // an owner named by email is held by id
    const byEmail = c.createOrganization(admin, { name: "By email", ownerId: ada.email });
    expect(c.members(byEmail.id)).toEqual([{ userId: ada.id, email: ada.email, role: "owner" }]);
  });

  test("an owner renames, adds and removes members; the last owner stays; a stranger is refused", () => {
    const { c, owed, person } = catalog();
    const ada = person("ada@example.com");
    const bob = person("bob@example.com");
    const org = c.createOrganization(as(ada), { name: "Booper" });
    owed();
    expect(refusal(() => c.renameOrganization(as(bob), org.id, "Mine")).code).toBe("FORBIDDEN");
    expect(c.renameOrganization(as(ada), org.id, "Booper Inc").name).toBe("Booper Inc");
    expect(
      refusal(() => c.addMember(as(ada), org.id, { userId: "user_nobody", role: "member" }))
        .message,
    ).toMatch(/No user/);
    c.addMember(as(ada), org.id, { userId: bob.email, role: "member" }); // by email, held by id
    c.addMember(as(ada), org.id, { userId: bob.id, role: "member" }); // the same again owes nothing
    expect(c.reach(bob.id).orgs).toEqual([
      { id: org.id, name: "Booper Inc", role: "member", projects: 0 },
    ]);
    expect(refusal(() => c.removeMember(as(ada), org.id, { userId: ada.id })).message).toBe(
      "An organization keeps at least one owner.",
    );
    // nor demoted
    expect(
      refusal(() => c.addMember(as(ada), org.id, { userId: ada.id, role: "member" })).message,
    ).toBe("An organization keeps at least one owner.");
    c.removeMember(as(ada), org.id, { userId: bob.email }); // by email, as added
    expect(c.reach(bob.id).orgs).toEqual([]);
    expect(owed().map(({ path, type }) => `${path} ${type}`)).toEqual([
      `/organizations/${org.id} organization/renamed`,
      "/ control-plane/organization-renamed",
      `/organizations/${org.id} organization/member-added`,
      `/users/${bob.id} organization/member-added`,
      "/ control-plane/member-added",
      `/organizations/${org.id} organization/member-removed`,
      `/users/${bob.id} organization/member-removed`,
      "/ control-plane/member-removed",
    ]);
  });

  test("deleted only while it holds no project; its memberships leave every member's account", () => {
    const { c, owed, person } = catalog();
    const ada = person("ada@example.com");
    const bob = person("bob@example.com");
    const org = c.createOrganization(as(ada), { name: "Booper" });
    c.addMember(as(ada), org.id, { userId: bob.id, role: "member" });
    c.createProject(as(ada), { project: "dawg", orgId: org.id });
    expect(refusal(() => c.deleteOrganization(as(ada), org.id)).message).toMatch(
      /still holds 1 project/,
    );
    const empty = c.createOrganization(as(ada), { name: "Empty" });
    c.addMember(as(ada), empty.id, { userId: bob.id, role: "member" });
    owed();
    c.deleteOrganization(as(ada), empty.id);
    expect(c.organization(empty.id)).toBeNull();
    expect(c.reach(bob.id).orgs.map(({ id }) => id)).toEqual([org.id]);
    expect(owed().map(({ path, type }) => `${path} ${type}`)).toEqual([
      `/users/${ada.id} organization/member-removed`,
      `/users/${bob.id} organization/member-removed`,
      `/organizations/${empty.id} organization/deleted`,
      "/ control-plane/organization-deleted",
    ]);
  });
});

describe("projects", () => {
  test("a slug is one project across every organization: the same organization's again is the same project, another's is refused before anything is made", () => {
    const { c, owed, person } = catalog();
    const ada = person("ada@example.com");
    const bob = person("bob@example.com");
    const org = c.createOrganization(as(ada), { name: "Booper" });
    owed();
    const dawg = c.createProject(as(ada), { project: "Dawg!", orgId: org.id });
    expect(dawg).toEqual({
      id: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
      slug: "dawg",
      orgId: org.id,
    });
    expect(owed()).toEqual([
      {
        path: `/organizations/${org.id}`,
        type: "organization/project-created",
        payload: { projectId: dawg.id, slug: "dawg" },
      },
      {
        path: "/",
        type: "control-plane/project-created",
        payload: { projectId: dawg.id, slug: "dawg", orgId: org.id },
      },
      {
        path: `${dawg.id}:/`,
        type: "project/create-requested",
        payload: { slug: "dawg", orgId: org.id },
      },
    ]);
    // asking again is the same project, and a new request on its root (the saga retries a failed
    // creation and ignores one after the certificate)
    const template = "github:iterate/config@0123456789abcdef0123456789abcdef01234567";
    expect(c.createProject(as(ada), { project: "dawg", configRepoTemplate: template })).toEqual(
      dawg,
    );
    expect(owed()).toEqual([
      {
        path: `${dawg.id}:/`,
        type: "project/create-requested",
        payload: { slug: "dawg", orgId: org.id, configRepoTemplate: template },
      },
    ]);
    // Bob has no organization yet: the refusal makes none
    expect(refusal(() => c.createProject(as(bob), { project: "dawg" })).code).toBe(
      "PROJECT_NAME_TAKEN",
    );
    expect(refusal(() => c.createProject(as(bob), { project: "x", orgId: org.id })).code).toBe(
      "FORBIDDEN",
    );
    expect(c.reach(bob.id)).toEqual({ orgs: [], projects: [] });
    expect(owed()).toEqual([]);
  });

  test("with no organization named: the person's first by name, made on first use after their email; the operator's own organization, made on first use", () => {
    const { c, person } = catalog();
    const ada = person("ada.lovelace@example.com");
    const first = c.createProject(as(ada), { project: "one" });
    const [org] = c.reach(ada.id).orgs;
    expect(org).toEqual({ id: first.orgId, name: "ada.lovelace", role: "owner", projects: 1 });
    expect(c.createProject(as(ada), { project: "two" }).orgId).toBe(first.orgId);
    expect(c.createProject(admin, { project: "ops", restoreProjectId: "prj_ops" })).toEqual({
      id: "prj_ops",
      slug: "ops",
      orgId: ADMIN_ORG_ID,
    });
    expect(c.organization(ADMIN_ORG_ID)).toEqual({ id: ADMIN_ORG_ID, name: "admin", projects: 1 });
    expect(c.members(ADMIN_ORG_ID)).toEqual([]);
    expect(
      refusal(() => c.createProject(as(ada), { project: "x", restoreProjectId: "prj_x" })).code,
    ).toBe("FORBIDDEN");
  });

  test("the operator restores a project under its archived id: the same archive again is the same project; a slug or an id bound elsewhere is refused", () => {
    const { c } = catalog();
    const restore = (project: string, restoreProjectId: string) =>
      c.createProject(admin, { project, restoreProjectId });
    expect(restore("garple", "prj_garple")).toEqual({
      id: "prj_garple",
      slug: "garple",
      orgId: ADMIN_ORG_ID,
    });
    expect(restore("garple", "prj_garple").id).toBe("prj_garple");
    expect(refusal(() => restore("garple", "prj_other"))).toMatchObject({
      code: "IDENTITY_CONFLICT",
      message: expect.stringMatching(/not the restored id/),
    });
    expect(refusal(() => restore("elsewhere", "prj_garple"))).toMatchObject({
      code: "IDENTITY_CONFLICT",
      message: expect.stringMatching(/already belongs/),
    });
    expect(refusal(() => restore("empty", "")).code).toBe("INVALID_INPUT");
  });

  test.for([
    ["Booper", "booper"],
    ["  My Project! v2 ", "my-project-v2"],
    ["--dawg--", "dawg"],
    ["!!!", ""],
  ] as const)("projectSlug(%j) is %j", ([name, slug]) => {
    expect(projectSlug(name)).toBe(slug);
  });
});
