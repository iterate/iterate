// Proves the org-membership itx.projects.create flow (DECISIONS D22) against
// a real D1 projects table and a (fake) Project DO: a member creates through
// their auth org (the auth worker — faked at the outbound-fetch boundary, see
// itx-projects.vitest.config.ts — mints the prj_ id), a stranger to the org
// is FORBIDDEN, a principal-less named-access handle is FORBIDDEN, and the
// admin operator path still mints locally without any auth call.
import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";

type ProjectResult = { id: string; slug: string; ingressUrl: string };

type HarnessStub = {
  create(input: {
    access: "all" | string[];
    project: { id?: string; slug: string; organizationSlug?: string };
    user?: {
      id: string;
      organizations: { id: string; name?: string; slug: string; role: "member" | "owner" }[];
    };
  }): Promise<ProjectResult>;
};

const harness = (env as unknown as { HARNESS: HarnessStub }).HARNESS;
const db = (env as unknown as { DB: D1Database }).DB;

const member = {
  id: "usr_member",
  organizations: [{ id: "org_acme", slug: "acme", role: "member" as const }],
};

beforeAll(async () => {
  await db
    .prepare(
      `create table if not exists projects (
        id text primary key not null,
        slug text not null unique,
        custom_hostname text unique,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      )`,
    )
    .run();
});

test("a member creates in their own org: the auth worker mints the id", async () => {
  const project = await harness.create({
    access: [],
    project: { slug: "member-project", organizationSlug: "acme" },
    user: member,
  });

  expect(project).toMatchObject({
    // The fake auth worker's deterministic mint — proof the id was adopted
    // from auth, not coined locally.
    id: "prj_authminted_memberproject",
    slug: "member-project",
    ingressUrl: "https://fake-project.test",
  });
  const row = await db
    .prepare("select id from projects where slug = ?")
    .bind("member-project")
    .first();
  expect(row).toEqual({ id: "prj_authminted_memberproject" });
});

test("the sole org is implied when no organizationSlug is passed", async () => {
  const project = await harness.create({
    access: [],
    project: { slug: "implied-org-project" },
    user: member,
  });
  expect(project.id).toBe("prj_authminted_impliedorgproject");
});

test("a stranger to the target org is FORBIDDEN before any side effect", async () => {
  const error = await harness
    .create({
      access: [],
      project: { slug: "intruder-project", organizationSlug: "other-org" },
      user: member,
    })
    .then(
      () => null,
      (thrown: unknown) => thrown as Error & { code?: unknown },
    );

  expect(error).not.toBeNull();
  expect(error!.code).toBe("FORBIDDEN");
  expect(
    await db.prepare("select id from projects where slug = ?").bind("intruder-project").first(),
  ).toBeNull();
});

test("a named-access handle without a principal (cap posture) is FORBIDDEN", async () => {
  const error = await harness
    .create({ access: ["prj_other"], project: { slug: "cap-project" } })
    .then(
      () => null,
      (thrown: unknown) => thrown as Error & { code?: unknown },
    );

  expect(error!.code).toBe("FORBIDDEN");
});

test("the admin operator path is unaffected: OS mints a prj_ id, no auth call", async () => {
  // Any auth-worker fetch would hit the fake's 500 fallback and fail this.
  const project = await harness.create({ access: "all", project: { slug: "operator-project" } });

  expect(project.id).toMatch(/^prj_/);
  expect(project.id).not.toContain("authminted");
  expect(project.slug).toBe("operator-project");
});
