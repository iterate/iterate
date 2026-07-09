import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Miniflare } from "miniflare";
import { createD1Client, type Client } from "sqlfu";
import { migrate } from "./db/migrations/.generated/migrations.ts";
import { insertUser, listOrganizationsForUser } from "./db/queries/index.ts";
import {
  ensureIterateOrganizationMembershipForNustomUser,
  ensureIterateOrganizationMembershipForNustomUserId,
  shouldAutoJoinIterateOrganization,
} from "./organization-auto-join.ts";

describe("organization auto-join", () => {
  it("matches only the nustom.com email domain", () => {
    assert.equal(shouldAutoJoinIterateOrganization("alice@nustom.com"), true);
    assert.equal(shouldAutoJoinIterateOrganization(" ALICE@NUSTOM.COM "), true);
    assert.equal(shouldAutoJoinIterateOrganization("alice@sub.nustom.com"), false);
    assert.equal(shouldAutoJoinIterateOrganization("alice@nustom.com.example"), false);
    assert.equal(shouldAutoJoinIterateOrganization("alice@example.com"), false);
  });

  it("joins nustom.com users to the iterate organization idempotently", async (t) => {
    const { client, dispose } = await createTestDb();
    t.after(dispose);

    await insertTestUser(client, {
      id: "usr_alice",
      email: "alice@nustom.com",
    });

    await ensureIterateOrganizationMembershipForNustomUser(client, {
      id: "usr_alice",
      email: "alice@nustom.com",
      emailVerified: 1,
    });
    await ensureIterateOrganizationMembershipForNustomUserId(client, "usr_alice");

    const organizations = await listOrganizationsForUser(client, { userId: "usr_alice" });
    assert.equal(organizations.length, 1);
    assert.equal(organizations[0]?.name, "Iterate");
    assert.equal(organizations[0]?.slug, "iterate");
    assert.equal(organizations[0]?.role, "member");
    assert.equal(await countMemberships(client, organizations[0]!.id, "usr_alice"), 1);
  });

  it("does not join other email domains", async (t) => {
    const { client, dispose } = await createTestDb();
    t.after(dispose);

    await insertTestUser(client, {
      id: "usr_bob",
      email: "bob@example.com",
    });

    await ensureIterateOrganizationMembershipForNustomUserId(client, "usr_bob");

    assert.deepEqual(await listOrganizationsForUser(client, { userId: "usr_bob" }), []);
  });

  it("does not join unverified nustom.com users", async (t) => {
    const { client, dispose } = await createTestDb();
    t.after(dispose);

    await insertTestUser(client, {
      id: "usr_unverified",
      email: "unverified@nustom.com",
      emailVerified: 0,
    });

    await ensureIterateOrganizationMembershipForNustomUserId(client, "usr_unverified");

    assert.deepEqual(await listOrganizationsForUser(client, { userId: "usr_unverified" }), []);
  });
});

async function createTestDb() {
  const mf = new Miniflare({
    script: "",
    modules: true,
    d1Databases: { DB: crypto.randomUUID() },
  });
  await mf.ready;

  const database = await mf.getD1Database("DB");
  const client = createD1Client(database);
  await migrate(client);

  return {
    client,
    dispose: () => mf.dispose(),
  };
}

async function insertTestUser(
  client: Client,
  input: { id: string; email: string; emailVerified?: number },
) {
  const now = Date.now();
  await insertUser(client, {
    id: input.id,
    name: input.email.split("@")[0] ?? input.email,
    email: input.email,
    emailVerified: input.emailVerified ?? 1,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function countMemberships(client: Client, organizationId: string, userId: string) {
  const [row] = await client.all<{ count: number }>({
    name: "countMemberships",
    sql: `
      SELECT COUNT(*) AS count
      FROM member
      WHERE organizationId = ?
        AND userId = ?
    `.trim(),
    args: [organizationId, userId],
  });
  return row?.count ?? 0;
}
