import { describe, expect, test } from "vitest";
import { directoryFor, type AuthDirectory, type KVLike } from "./directory.ts";

// Pure unit tests for the DIRECTORY authority (no worker, no transport). The full capnweb chain and
// the live auth-prd binding are proven against prd; here we prove access/list/create per provider —
// the auth provider driven by a MOCK of auth's RPC, the kv provider by a Map-backed KV.
const anon = { credentials: [] };
// A logged-in caller: a verified wall JWT. The directory resolves membership by the auth user id when
// the wall mapped it into `custom.sub` (Cloudflare Access), else by the verified email. Pass userId to
// exercise the preferred path; omit it to exercise the email fallback.
const caller = (email: string, userId?: string) => ({
  credentials: [
    {
      format: "jwt",
      issuer: "a-wall",
      jwt: unsignedJwt(userId ? { email, custom: { sub: userId } } : { email }),
    },
  ],
});

function unsignedJwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJub25lIn0.${payload}.`;
}

// Map-backed KV, structurally a KVLike — real create/read/list logic, no worker needed.
function mockKV(): KVLike {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    list: async ({ prefix } = {}) => ({
      keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

// Mock auth-prd: project "alice" exists (prj_alice); "member@x.com" is a member; create echoes a row.
const mockAuth: AuthDirectory = {
  getProjectBySlug: async ({ projectSlug }) =>
    projectSlug === "alice" ? { id: "prj_alice", slug: "alice", organizationId: "org_1" } : null,
  listProjectsForUser: async () => [], // no longer used by the provider (membership is by userId/email)
  getUserGrants: async ({ userId }) => ({
    projects:
      userId === "usr_member" ? [{ id: "prj_alice", slug: "alice", organizationId: "org_1" }] : [],
  }),
  getUserGrantsByEmail: async ({ email }) => ({
    projects:
      email === "member@x.com" ? [{ id: "prj_alice", slug: "alice", organizationId: "org_1" }] : [],
  }),
  createProjectForOrganization: async ({ name, slug }) => ({
    ok: true,
    project: { id: "prj_new", slug: slug ?? name },
  }),
};

describe("directory access + list", () => {
  test("open: every project reachable by anyone; can't enumerate", async () => {
    const d = directoryFor({ directory: { provider: "open" } }, {});
    expect(await d.access(anon, "alice")).toEqual({ ok: true });
    expect(await d.list(anon)).toEqual([]);
  });

  test("open is the default when no directory is configured", async () => {
    expect(await directoryFor({}, {}).access(anon, "alice")).toEqual({ ok: true });
  });

  test("local: only the configured set exists", async () => {
    const d = directoryFor({ directory: { provider: "local", projects: ["alice", "bob"] } }, {});
    expect(await d.access(anon, "alice")).toEqual({ ok: true });
    expect(await d.access(anon, "carol")).toMatchObject({ ok: false });
    expect(await d.list(anon)).toEqual(["alice", "bob"]);
  });

  test("auth.iterate.com: existence + membership from the real directory (mocked)", async () => {
    const d = directoryFor({ directory: { provider: "auth.iterate.com" } }, { AUTH: mockAuth });
    // Preferred path: the wall mapped the auth userId into custom.sub.
    expect(await d.access(caller("any@x.com", "usr_member"), "alice")).toEqual({ ok: true });
    expect(await d.access(caller("any@x.com", "usr_other"), "alice")).toMatchObject({
      ok: false,
      reason: /not a member/,
    });
    // Fallback path: no userId claim => resolve by verified email.
    expect(await d.access(caller("member@x.com"), "alice")).toEqual({ ok: true });
    expect(await d.access(caller("other@x.com"), "alice")).toMatchObject({
      ok: false,
      reason: /not a member/,
    });
    expect(await d.access(anon, "alice")).toMatchObject({ ok: false, reason: /not a member/ });
    expect(await d.access(caller("any@x.com", "usr_member"), "bob")).toMatchObject({
      ok: false,
      reason: /no such project/,
    });
    expect(await d.list(caller("any@x.com", "usr_member"))).toEqual(["alice"]);
    expect(await d.list(caller("member@x.com"))).toEqual(["alice"]);
  });
});

describe("directory create — works in both modes (slug, no name — apps/os shape)", () => {
  test("open: a project exists the moment you name its slug", async () => {
    const d = directoryFor({ directory: { provider: "open" } }, {});
    expect(await d.create(anon, { slug: "My App" })).toEqual({
      ok: true,
      project: { id: "my-app", slug: "my-app" }, // slug normalized
    });
  });

  test("local: read-only, create is refused", async () => {
    const d = directoryFor({ directory: { provider: "local", projects: ["alice"] } }, {});
    expect(await d.create(anon, { slug: "new" })).toMatchObject({ ok: false, reason: /read-only/ });
  });

  test("kv (self-host): create persists — then access + list see it", async () => {
    const d = directoryFor({ directory: { provider: "kv" } }, { DIRECTORY_KV: mockKV() });
    expect(await d.access(anon, "acme-co")).toMatchObject({ ok: false, exists: false }); // not yet
    expect(await d.create(anon, { slug: "Acme Co" })).toEqual({
      ok: true,
      project: { id: "acme-co", slug: "acme-co" },
    });
    expect(await d.access(anon, "acme-co")).toEqual({ ok: true }); // now it exists
    expect(await d.list(anon)).toEqual(["acme-co"]); // and enumerates
  });

  test("auth.iterate.com (hosted): create writes to auth under an explicit org", async () => {
    const d = directoryFor({ directory: { provider: "auth.iterate.com" } }, { AUTH: mockAuth });
    // An explicit organizationSlug is the owning org (apps/os get(slug).create({ organizationSlug })).
    // It's the security-relevant input; auth-prd owns the actual write. Works logged-in or anonymous.
    expect(await d.create(caller("u1"), { slug: "np", organizationSlug: "acme-org" })).toEqual({
      ok: true,
      project: { id: "prj_new", slug: "np" },
    });
    expect(await d.create(anon, { slug: "np", organizationSlug: "acme-org" })).toMatchObject({
      ok: true,
    });
    // No org => nothing to create under.
    expect(await d.create(caller("u1"), { slug: "np" })).toMatchObject({
      ok: false,
      reason: /pass organizationSlug/,
    });
  });
});
