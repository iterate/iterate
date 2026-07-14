import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DB } from "./db/index.ts";
import { buildOAuthProjectSelectionReferenceId } from "./oauth-project-selection.ts";
import { introspectAccessToken } from "./oauth-token-introspection.ts";

type Query = { name: string; args: unknown[] };

function fakeDb(respond: (query: Query) => unknown[]) {
  return {
    all: async (query: Query) => respond(query),
  } as unknown as DB;
}

function introspect(client: DB) {
  return introspectAccessToken({
    input: { token: "raw-access-token", audiences: ["https://mcp.iterate.com"] },
    client,
    issuer: "https://auth.iterate.com/api/auth",
  });
}

function storedToken(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "oat_one",
    clientId: "mcp-client",
    userId: "usr_one",
    expiresAt: now + 60_000,
    createdAt: now - 1_000,
    scopes: JSON.stringify(["openid"]),
    clientDisabled: 0,
    ...overrides,
  };
}

describe("private OAuth access-token introspection", () => {
  it("does not expose an unknown opaque token", async () => {
    const result = await introspect(
      fakeDb((query) => {
        assert.equal(query.name, "getOAuthAccessTokenForInternalIntrospection");
        assert.equal(typeof query.args[0], "string");
        assert.notEqual(query.args[0], "raw-access-token");
        return [];
      }),
    );

    assert.deepEqual(result, { active: false, reason: "not_found" });
  });

  for (const testCase of [
    {
      name: "expired token",
      overrides: { expiresAt: Date.now() - 1 },
      reason: "expired",
    },
    {
      name: "disabled client",
      overrides: { clientDisabled: 1 },
      reason: "client_disabled",
    },
    {
      name: "token without a user",
      overrides: { userId: undefined },
      reason: "missing_user",
    },
    {
      name: "expired backing session",
      overrides: { sessionId: "session_one", sessionExpiresAt: Date.now() - 1 },
      reason: "session_expired",
    },
  ]) {
    it(`rejects ${testCase.name}`, async () => {
      const result = await introspect(
        fakeDb((query) => {
          assert.equal(query.name, "getOAuthAccessTokenForInternalIntrospection");
          return [storedToken(testCase.overrides)];
        }),
      );

      assert.deepEqual(result, { active: false, reason: testCase.reason });
    });
  }

  it("reconstructs project-scoped claims from auth-owned membership data", async () => {
    const createdAt = Date.now() - 1_000;
    const expiresAt = Date.now() + 60_000;
    const result = await introspect(
      fakeDb((query) => {
        switch (query.name) {
          case "getOAuthAccessTokenForInternalIntrospection":
            return [
              storedToken({
                createdAt,
                expiresAt,
                scopes: JSON.stringify(["openid", "project"]),
                referenceId: buildOAuthProjectSelectionReferenceId({
                  userId: "usr_one",
                  projectIds: ["prj_alpha"],
                }),
                userRole: "admin",
              }),
            ];
          case "listOrganizationsForUser":
            assert.deepEqual(query.args, ["usr_one"]);
            return [{ id: "org_one", name: "One", slug: "one", role: "owner" }];
          case "listProjectsForUser":
            assert.deepEqual(query.args, ["usr_one"]);
            return [
              {
                id: "prj_alpha",
                organizationId: "org_one",
                name: "Alpha",
                slug: "alpha",
                metadata: "{}",
              },
              {
                id: "prj_beta",
                organizationId: "org_one",
                name: "Beta",
                slug: "beta",
                metadata: "{}",
              },
            ];
          default:
            throw new Error(`Unexpected query ${query.name}`);
        }
      }),
    );

    assert.deepEqual(result, {
      active: true,
      sub: "usr_one",
      sid: undefined,
      clientId: "mcp-client",
      iss: "https://auth.iterate.com/api/auth",
      aud: ["https://mcp.iterate.com"],
      iat: Math.floor(createdAt / 1_000),
      exp: Math.floor(expiresAt / 1_000),
      scope: "openid project project:prj_alpha",
      scopes: ["openid", "project", "project:prj_alpha"],
      organizations: [{ id: "org_one", name: "One", slug: "one", role: "owner" }],
      projects: [{ id: "prj_alpha", slug: "alpha", organizationId: "org_one" }],
      isAdmin: true,
      role: "admin",
    });
  });
});
