import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "sqlfu";
import type { DB } from "./db/index.ts";
import { ensureOrganizationForProjectSeed } from "./organization-seed.ts";

type State = {
  memberships: Array<{
    id: string;
    organizationId: string;
    role: string;
    userId: string;
  }>;
  organizations: Array<{ id: string; name: string; slug: string }>;
  users: Array<{ id: string }>;
};

function fakeDb(state: State): DB {
  const client = {
    all: async (query: { args: unknown[]; name: string }) => {
      switch (query.name) {
        case "getUserById":
          return state.users.filter((user) => user.id === query.args[0]);
        case "getOrganizationBySlug":
          return state.organizations.filter((organization) => organization.slug === query.args[0]);
        case "getMembershipByOrganizationAndUserId":
          return state.memberships.filter(
            (membership) =>
              membership.organizationId === query.args[0] && membership.userId === query.args[1],
          );
        default:
          throw new Error(`Unexpected read ${query.name}`);
      }
    },
    run: async (query: { args: unknown[]; name: string }) => {
      switch (query.name) {
        case "insertOrganization":
          state.organizations.push({
            id: query.args[0] as string,
            name: query.args[1] as string,
            slug: query.args[2] as string,
          });
          break;
        case "updateOrganizationNameById": {
          const organization = state.organizations.find(
            (candidate) => candidate.id === query.args[1],
          );
          if (organization) organization.name = query.args[0] as string;
          break;
        }
        case "insertMembership":
          state.memberships.push({
            id: query.args[0] as string,
            organizationId: query.args[1] as string,
            userId: query.args[2] as string,
            role: query.args[3] as string,
          });
          break;
        case "updateMembershipRoleByOrganizationAndUserId": {
          const membership = state.memberships.find(
            (candidate) =>
              candidate.organizationId === query.args[1] && candidate.userId === query.args[2],
          );
          if (membership) membership.role = query.args[0] as string;
          break;
        }
        default:
          throw new Error(`Unexpected write ${query.name}`);
      }
      return { changes: 1 };
    },
    transaction: async <T>(callback: (tx: Client) => Promise<T>) =>
      await callback(client as unknown as Client),
  };
  return client as unknown as DB;
}

describe("ensureOrganizationForProjectSeed", () => {
  it("creates the organization and declared memberships", async () => {
    const state: State = {
      memberships: [],
      organizations: [],
      users: [{ id: "usr_jonas" }, { id: "usr_misha" }],
    };

    const organization = await ensureOrganizationForProjectSeed(fakeDb(state), {
      name: "Iterate",
      slug: "iterate",
      members: [
        { userId: "usr_jonas", role: "owner" },
        { userId: "usr_misha", role: "admin" },
      ],
    });

    assert.equal(organization.slug, "iterate");
    assert.deepEqual(
      state.memberships.map(({ role, userId }) => ({ role, userId })),
      [
        { role: "owner", userId: "usr_jonas" },
        { role: "admin", userId: "usr_misha" },
      ],
    );
  });

  it("updates declared state without removing undeclared members", async () => {
    const state: State = {
      organizations: [{ id: "org_iterate", name: "Old name", slug: "iterate" }],
      users: [{ id: "usr_jonas" }, { id: "usr_misha" }],
      memberships: [
        {
          id: "member_jonas",
          organizationId: "org_iterate",
          role: "member",
          userId: "usr_jonas",
        },
        {
          id: "member_misha",
          organizationId: "org_iterate",
          role: "admin",
          userId: "usr_misha",
        },
      ],
    };

    await ensureOrganizationForProjectSeed(fakeDb(state), {
      name: "Iterate",
      slug: "iterate",
      members: [{ userId: "usr_jonas", role: "owner" }],
    });

    assert.equal(state.organizations[0]?.name, "Iterate");
    assert.deepEqual(
      state.memberships.map(({ role, userId }) => ({ role, userId })),
      [
        { role: "owner", userId: "usr_jonas" },
        { role: "admin", userId: "usr_misha" },
      ],
    );
  });

  it("fails before writes when a declared user is missing", async () => {
    const state: State = { memberships: [], organizations: [], users: [] };
    await assert.rejects(
      ensureOrganizationForProjectSeed(fakeDb(state), {
        name: "Iterate",
        slug: "iterate",
        members: [{ userId: "usr_missing", role: "owner" }],
      }),
      /user usr_missing not found/,
    );
    assert.deepEqual(state.organizations, []);
  });
});
