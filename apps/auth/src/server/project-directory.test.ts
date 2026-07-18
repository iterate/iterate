import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DB } from "./db/index.ts";
import {
  getProjectBySlug,
  listProjects,
  listProjectsForUser,
  registerProject,
  toOwnedProjectRecord,
  userCanAccessProject,
} from "./project-directory.ts";

type Query = { name: string; args: unknown[] };

function fakeDb(respond: (query: Query) => unknown[]) {
  return {
    all: async (query: Query) => respond(query),
    run: async (query: Query) => {
      respond(query);
      return {};
    },
  } as unknown as DB;
}

describe("private auth project directory", () => {
  it("durably registers an explicitly unowned project", async () => {
    const queries: Query[] = [];
    const result = await registerProject(
      {
        id: "prj_fixture",
        organizationSlug: null,
        name: "Admin Fixture",
        slug: "admin-fixture",
      },
      fakeDb((query) => {
        queries.push(query);
        if (query.name === "insertProjectIfAbsent") return [];
        if (query.name === "getProjectById") {
          return [
            {
              id: "prj_fixture",
              organizationId: null,
              name: "Admin Fixture",
              slug: "admin-fixture",
              metadata: "{}",
              archivedAt: undefined,
            },
          ];
        }
        throw new Error(`Unexpected query ${query.name}`);
      }),
    );

    assert.deepEqual(result, {
      ok: true,
      project: {
        id: "prj_fixture",
        organizationId: null,
        creatorEmail: null,
        name: "Admin Fixture",
        slug: "admin-fixture",
        metadata: {},
        archivedAt: null,
      },
    });
    assert.deepEqual(
      queries.map((query) => query.name),
      ["insertProjectIfAbsent", "getProjectById"],
    );
    assert.deepEqual(queries[0]?.args.slice(0, 5), [
      "prj_fixture",
      null,
      null,
      "Admin Fixture",
      "admin-fixture",
    ]);
  });

  it("adopts the canonical project when a generated id loses a concurrent slug race", async () => {
    const canonical = {
      id: "prj_winner",
      organizationId: null,
      name: "Admin Fixture",
      slug: "admin-fixture-race",
      metadata: "{}",
      archivedAt: undefined,
    };
    const queries: Query[] = [];
    const result = await registerProject(
      { organizationSlug: null, name: "Admin Fixture", slug: canonical.slug },
      fakeDb((query) => {
        queries.push(query);
        if (query.name === "insertProjectIfAbsent") return [];
        if (query.name === "getProjectBySlug") return [canonical];
        throw new Error(`Unexpected query ${query.name}`);
      }),
    );

    if (!result.ok) throw new Error(result.message);
    assert.equal(result.project.id, canonical.id);
    assert.equal(result.project.organizationId, null);
    assert.equal(result.project.creatorEmail, null);
    assert.match(queries[0]?.args[0] as string, /^prj_[a-f0-9]{32}$/);
    assert.deepEqual(
      queries.map((query) => query.name),
      ["insertProjectIfAbsent", "getProjectBySlug"],
    );
  });

  it("reuses the durable project id when OS retries after registration", async () => {
    let canonical:
      | {
          archivedAt: undefined;
          id: string;
          creatorEmail: null;
          metadata: string;
          name: string;
          organizationId: null;
          slug: string;
        }
      | undefined;
    const queries: string[] = [];
    const client = fakeDb((query) => {
      queries.push(query.name);
      if (query.name === "insertProjectIfAbsent") {
        canonical ??= {
          id: query.args[0] as string,
          organizationId: null,
          creatorEmail: null,
          name: query.args[3] as string,
          slug: query.args[4] as string,
          metadata: query.args[5] as string,
          archivedAt: undefined,
        };
        return [];
      }
      if (query.name === "getProjectBySlug") return canonical ? [canonical] : [];
      throw new Error(`Unexpected query ${query.name}`);
    });
    const input = { organizationSlug: null, name: "Retry Fixture", slug: "retry-fixture" } as const;

    const first = await registerProject(input, client);
    // Model a later OS birth append failing: auth's durable row survives, and
    // the caller repeats the same create without knowing the generated id.
    const retried = await registerProject(input, client);

    if (!first.ok || !retried.ok) throw new Error("Expected both registrations to resolve");
    assert.equal(retried.project.id, first.project.id);
    assert.match(first.project.id, /^prj_[a-f0-9]{32}$/);
    assert.deepEqual(queries, [
      "insertProjectIfAbsent",
      "getProjectBySlug",
      "insertProjectIfAbsent",
      "getProjectBySlug",
    ]);
  });

  it("returns one creator email to concurrent org callers so birth retries stay identical", async () => {
    let canonical:
      | {
          archivedAt: undefined;
          creatorEmail: string;
          id: string;
          metadata: string;
          name: string;
          organizationId: string;
          slug: string;
        }
      | undefined;
    const client = fakeDb((query) => {
      if (query.name === "getOrganizationBySlug") {
        return [{ id: "org_one", name: "One", slug: "one" }];
      }
      if (query.name === "insertProjectIfAbsent") {
        canonical ??= {
          id: query.args[0] as string,
          organizationId: query.args[1] as string,
          creatorEmail: query.args[2] as string,
          name: query.args[3] as string,
          slug: query.args[4] as string,
          metadata: query.args[5] as string,
          archivedAt: undefined,
        };
        return [];
      }
      if (query.name === "getProjectBySlug") return canonical ? [canonical] : [];
      throw new Error(`Unexpected query ${query.name}`);
    });
    const base = { organizationSlug: "one", name: "Shared", slug: "shared" } as const;

    const [owner, teammate] = await Promise.all([
      registerProject({ ...base, creatorEmail: "owner@example.com" }, client),
      registerProject({ ...base, creatorEmail: "teammate@example.com" }, client),
    ]);
    const retried = await registerProject(
      { ...base, creatorEmail: "renamed-owner@example.com" },
      client,
    );

    if (!owner.ok || !teammate.ok || !retried.ok) {
      throw new Error("Expected every registration to adopt the canonical project");
    }
    assert.ok(canonical);
    assert.equal(teammate.project.id, owner.project.id);
    assert.equal(retried.project.id, owner.project.id);
    assert.equal(owner.project.creatorEmail, canonical.creatorEmail);
    assert.equal(teammate.project.creatorEmail, canonical.creatorEmail);
    assert.equal(retried.project.creatorEmail, canonical.creatorEmail);
  });

  it("looks up a project by slug and maps only the public directory record", async () => {
    const project = await getProjectBySlug(
      { projectSlug: "alpha" },
      fakeDb((query) => {
        assert.equal(query.name, "getProjectBySlug");
        assert.deepEqual(query.args, ["alpha"]);
        return [
          {
            id: "prj_alpha",
            organizationId: "org_one",
            name: "Alpha",
            slug: "alpha",
            metadata: JSON.stringify({ region: "eu" }),
            archivedAt: undefined,
          },
        ];
      }),
    );

    assert.deepEqual(project, {
      id: "prj_alpha",
      organizationId: "org_one",
      creatorEmail: null,
      name: "Alpha",
      slug: "alpha",
      metadata: { region: "eu" },
      archivedAt: null,
    });
  });

  it("keeps the canonical creator email off the public project record", () => {
    assert.deepEqual(
      toOwnedProjectRecord({
        id: "prj_public",
        organizationId: "org_one",
        creatorEmail: "owner@example.com",
        name: "Public",
        slug: "public",
        metadata: {},
        archivedAt: null,
      }),
      {
        id: "prj_public",
        organizationId: "org_one",
        name: "Public",
        slug: "public",
        metadata: {},
        archivedAt: null,
      },
    );
  });

  it("lists owned and explicitly unowned projects from the durable directory", async () => {
    const projects = await listProjects(
      { limit: 100 },
      fakeDb((query) => {
        assert.equal(query.name, "listProjects");
        assert.deepEqual(query.args, [100]);
        return [
          {
            id: "prj_owned",
            organizationId: "org_one",
            name: "Owned",
            slug: "owned",
            metadata: "{}",
            archivedAt: undefined,
          },
          {
            id: "prj_fixture",
            organizationId: null,
            name: "Fixture",
            slug: "fixture",
            metadata: "{}",
            archivedAt: undefined,
          },
        ];
      }),
    );

    assert.deepEqual(
      projects.map(({ id, organizationId, slug }) => ({ id, organizationId, slug })),
      [
        { id: "prj_owned", organizationId: "org_one", slug: "owned" },
        { id: "prj_fixture", organizationId: null, slug: "fixture" },
      ],
    );
  });

  it("reports a missing organization without attempting a project write", async () => {
    const queries: string[] = [];
    const result = await registerProject(
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
    const result = await registerProject(
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
          case "insertProjectIfAbsent":
            return [];
          case "getProjectById":
            return [
              {
                id: "prj_exact",
                organizationId: "org_one",
                name: "Alpha Project",
                slug: "alpha-project",
                metadata: JSON.stringify({ region: "eu" }),
                archivedAt: null,
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
        creatorEmail: null,
        name: "Alpha Project",
        slug: "alpha-project",
        metadata: { region: "eu" },
        archivedAt: null,
      },
    });
    assert.deepEqual(
      queries.map((query) => query.name),
      ["getOrganizationBySlug", "insertProjectIfAbsent", "getProjectById"],
    );
    assert.deepEqual(queries[1]?.args.slice(0, 6), [
      "prj_exact",
      "org_one",
      null,
      "Alpha Project",
      "alpha-project",
      JSON.stringify({ region: "eu" }),
    ]);
  });

  it("adopts an existing exact id only when its slug and organization match", async () => {
    const queries: string[] = [];
    const result = await registerProject(
      { id: "prj_existing", organizationSlug: "one", name: "Existing" },
      fakeDb((query) => {
        queries.push(query.name);
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "insertProjectIfAbsent") return [];
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
    assert.deepEqual(queries, ["getOrganizationBySlug", "insertProjectIfAbsent", "getProjectById"]);
  });

  it("rejects a slug already owned by another organization", async () => {
    const result = await registerProject(
      { organizationSlug: "one", name: "Taken" },
      fakeDb((query) => {
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "insertProjectIfAbsent") return [];
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
    const result = await registerProject(
      { id: "prj_other", organizationSlug: "one", name: "Requested" },
      fakeDb((query) => {
        if (query.name === "getOrganizationBySlug") {
          return [{ id: "org_one", name: "One", slug: "one" }];
        }
        if (query.name === "insertProjectIfAbsent") return [];
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
        assert.deepEqual(query.args, ["usr_jonas", "prj_banana"]);
        return [{ userRole: "admin", hasMembership: 0 }];
      }),
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
