import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DB } from "./db/index.ts";
import {
  createProjectForOrganization,
  getProjectBySlug,
  listProjectsForUser,
  mintProjectId,
  userCanAccessProject,
} from "./project-directory.ts";

type Query = { name: string; args: unknown[] };

function fakeDb(respond: (query: Query) => unknown[]) {
  return {
    all: async (query: Query) => respond(query),
  } as unknown as DB;
}

describe("private auth project directory", () => {
  it("mints auth-owned project identifiers", async () => {
    const { id } = await mintProjectId();
    assert.match(id, /^prj_[a-f0-9]{32}$/);
  });

  it("looks up a project by slug and maps only the public directory record", async () => {
    const project = await getProjectBySlug(
      { projectSlug: "alpha" },
      fakeDb((query) => {
        assert.equal(query.name, "getProjectWithOrganizationBySlug");
        assert.deepEqual(query.args, ["alpha"]);
        return [
          {
            id: "prj_alpha",
            organizationId: "org_one",
            name: "Alpha",
            slug: "alpha",
            metadata: JSON.stringify({ region: "eu" }),
            archivedAt: undefined,
            organizationRecordId: "org_one",
            organizationName: "One",
            organizationSlug: "one",
          },
        ];
      }),
    );

    assert.deepEqual(project, {
      id: "prj_alpha",
      organizationId: "org_one",
      name: "Alpha",
      slug: "alpha",
      metadata: { region: "eu" },
      archivedAt: null,
    });
  });

  it("reports a missing organization without attempting a project write", async () => {
    const queries: string[] = [];
    const result = await createProjectForOrganization(
      { organizationSlug: "missing", name: "Alpha" },
      fakeDb((query) => {
        queries.push(query.name);
        assert.equal(query.name, "getOrganizationBySlug");
        return [];
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reason: "organization_not_found",
      message: "Organization not found",
    });
    assert.deepEqual(queries, ["getOrganizationBySlug"]);
  });

  it("creates the exact caller-minted project id", async () => {
    const queries: Query[] = [];
    const result = await createProjectForOrganization(
      {
        id: "prj_exact",
        organizationSlug: "one",
        name: "Alpha Project",
        metadata: { region: "eu" },
      },
      fakeDb((query) => {
        queries.push(query);
        switch (query.name) {
          case "getOrganizationBySlug":
            return [{ id: "org_one", name: "One", slug: "one" }];
          case "getProjectById":
          case "getProjectBySlug":
            return [];
          case "insertProjectReturning":
            return [
              {
                id: "prj_exact",
                organization_id: "org_one",
                name: "Alpha Project",
                slug: "alpha-project",
                metadata: JSON.stringify({ region: "eu" }),
                archived_at: null,
              },
            ];
          default:
            throw new Error(`Unexpected query ${query.name}`);
        }
      }),
    );

    assert.deepEqual(result, {
      ok: true,
      project: {
        id: "prj_exact",
        organizationId: "org_one",
        name: "Alpha Project",
        slug: "alpha-project",
        metadata: { region: "eu" },
        archivedAt: null,
      },
    });
    assert.deepEqual(
      queries.map((query) => query.name),
      ["getOrganizationBySlug", "getProjectById", "getProjectBySlug", "insertProjectReturning"],
    );
    assert.deepEqual(queries.at(-1)?.args.slice(0, 6), [
      "prj_exact",
      "org_one",
      "Alpha Project",
      "alpha-project",
      JSON.stringify({ region: "eu" }),
      null,
    ]);
  });

  it("adopts an existing exact id only when its slug and organization match", async () => {
    const queries: string[] = [];
    const result = await createProjectForOrganization(
      { id: "prj_existing", organizationSlug: "one", name: "Existing" },
      fakeDb((query) => {
        queries.push(query.name);
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "getProjectById") {
          return [
            {
              id: "prj_existing",
              organizationId: "org_one",
              name: "Existing",
              slug: "existing",
              metadata: "{}",
              archivedAt: undefined,
            },
          ];
        }
        throw new Error(`Unexpected query ${query.name}`);
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(queries, ["getOrganizationBySlug", "getProjectById"]);
  });

  it("rejects a slug already owned by another organization", async () => {
    const result = await createProjectForOrganization(
      { organizationSlug: "one", name: "Taken" },
      fakeDb((query) => {
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "getProjectBySlug") {
          return [
            {
              id: "prj_other",
              organizationId: "org_other",
              name: "Taken",
              slug: "taken",
              metadata: "{}",
              archivedAt: undefined,
            },
          ];
        }
        throw new Error(`Unexpected query ${query.name}`);
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reason: "conflict",
      message: "Project slug taken is already taken.",
    });
  });

  it("does not reveal another organization's project when an id collides", async () => {
    const result = await createProjectForOrganization(
      { id: "prj_other", organizationSlug: "one", name: "Requested" },
      fakeDb((query) => {
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "getProjectById") {
          return [
            {
              id: "prj_other",
              organizationId: "org_private",
              name: "Private project",
              slug: "secret-project-slug",
              metadata: "{}",
              archivedAt: undefined,
            },
          ];
        }
        throw new Error(`Unexpected query ${query.name}`);
      }),
    );

    assert.deepEqual(result, {
      ok: false,
      reason: "conflict",
      message: "Project identity is already taken.",
    });
    if (result.ok) throw new Error("Expected a project identity conflict");
    assert.doesNotMatch(result.message, /private|secret/i);
  });

  it("scopes stale-claim membership reads to the requested user", async () => {
    const projects = await listProjectsForUser(
      { userId: " user_one " },
      fakeDb((query) => {
        assert.equal(query.name, "listProjectsForUser");
        assert.deepEqual(query.args, ["user_one"]);
        return [
          {
            id: "prj_alpha",
            organizationId: "org_one",
            name: "Alpha",
            slug: "alpha",
            metadata: JSON.stringify({ private: "not returned" }),
          },
        ];
      }),
    );

    assert.deepEqual(projects, [{ id: "prj_alpha", slug: "alpha", organizationId: "org_one" }]);
  });

  it("lets platform admins access an existing project without organization membership", async () => {
    const canAccess = await userCanAccessProject(
      { projectId: "prj_banana", userId: "usr_jonas" },
      fakeDb((query) => {
        assert.equal(query.name, "getProjectAccessForUser");
        assert.deepEqual(query.args, ["prj_banana", "usr_jonas"]);
        return [{ userRole: "admin", hasMembership: 0 }];
      }),
    );

    assert.equal(canAccess, true);
  });

  it("lets platform admins access admin-lane projects that have no directory row", async () => {
    // The access query anchors on the USER row: a project created through the
    // deployment admin secret never registers in this directory, and before
    // the reanchoring that made it invisible to project-app auth for
    // EVERYONE — the admin role must carry regardless of a project row.
    const canAccess = await userCanAccessProject(
      { projectId: "prj_created_via_admin_api", userId: "usr_jonas" },
      fakeDb(() => [{ userRole: "admin", hasMembership: 0 }]),
    );

    assert.equal(canAccess, true);
  });

  it("requires organization membership for non-admin users", async () => {
    for (const [rows, expected] of [
      [[{ userRole: "user", hasMembership: 1 }], true],
      [[{ userRole: "user", hasMembership: 0 }], false],
      [[], false],
    ] as const) {
      const canAccess = await userCanAccessProject(
        { projectId: "prj_banana", userId: "usr_regular" },
        fakeDb(() => [...rows]),
      );
      assert.equal(canAccess, expected);
    }
  });

  it("rejects an empty user id before querying", async () => {
    await assert.rejects(
      listProjectsForUser(
        { userId: " " },
        fakeDb(() => {
          throw new Error("database should not be queried");
        }),
      ),
    );
  });
});
