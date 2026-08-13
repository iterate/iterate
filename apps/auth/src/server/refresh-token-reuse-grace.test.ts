import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

// Regression tests for the refresh-token reuse grace window added in
// patches/@better-auth__oauth-provider@1.6.9.patch.
//
// Upstream rotates the refresh token on every use and treats ANY reuse of a
// rotated token as theft, deleting every refresh token the user holds for
// that client. Cookie relying parties (apps/os) fire bursts of parallel
// requests that race the rotation across worker isolates — the losers present
// the token the winner just rotated and upstream's response signed the user
// out of everything (the post-deploy "Sign-in could not be verified" page).
// The patch turns reuse within a short grace window into a benign fork of the
// token chain; reuse after the window keeps the theft response.

const BASE_URL = "http://localhost:3000";
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-client-secret-value";
const RAW_REFRESH_TOKEN = "raw-refresh-token-original";
const USER_ID = "user_1";

// The oauth-provider stores client secrets and opaque tokens as unsalted
// SHA-256 base64url (its defaultHasher for storeClientSecret/storeTokens
// "hashed"); seeded rows must use the same format.
async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

type MemoryDB = Record<string, Record<string, unknown>[]>;

async function createSeededAuth() {
  const db: MemoryDB = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
  };
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "refresh-grace-test-secret-refresh-grace-test-secret",
    database: memoryAdapter(db),
    plugins: [jwt(), oauthProvider({ loginPage: "/login", consentPage: "/consent" })],
    telemetry: { enabled: false },
  });

  const now = new Date();
  db.user.push({
    id: USER_ID,
    name: "Grace Test",
    email: "grace@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  db.oauthClient.push({
    id: "client_row_1",
    clientId: CLIENT_ID,
    clientSecret: await sha256Base64Url(CLIENT_SECRET),
    disabled: false,
    redirectUris: JSON.stringify(["http://localhost:5173/callback"]),
    createdAt: now,
    updatedAt: now,
  });
  db.oauthRefreshToken.push({
    id: "refresh_row_1",
    token: await sha256Base64Url(RAW_REFRESH_TOKEN),
    clientId: CLIENT_ID,
    sessionId: null,
    userId: USER_ID,
    referenceId: null,
    authTime: now,
    scopes: ["profile", "offline_access"],
    createdAt: now,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revoked: null,
  });

  return { auth, db };
}

async function refreshGrant(
  auth: { handler: (request: Request) => Promise<Response> },
  rawToken: string,
) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rawToken }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

describe("refresh token rotation reuse grace window", () => {
  let auth: Awaited<ReturnType<typeof createSeededAuth>>["auth"];
  let db: MemoryDB;

  beforeEach(async () => {
    ({ auth, db } = await createSeededAuth());
  });

  it("rotates the refresh token on first use", async () => {
    const { response, body } = await refreshGrant(auth, RAW_REFRESH_TOKEN);

    assert.equal(response.status, 200);
    assert.ok(typeof body.refresh_token === "string" && !!body.refresh_token.length);
    assert.notEqual(body.refresh_token, RAW_REFRESH_TOKEN);

    const originalRow = db.oauthRefreshToken.find((row) => row.id === "refresh_row_1");
    assert.ok(originalRow?.revoked, "used token is marked revoked");
    assert.equal(db.oauthRefreshToken.length, 2);
  });

  it("forks the chain instead of revoking the family on reuse within the grace window", async () => {
    const first = await refreshGrant(auth, RAW_REFRESH_TOKEN);
    assert.equal(first.response.status, 200);
    const revokedAtAfterFirstUse = db.oauthRefreshToken.find(
      (row) => row.id === "refresh_row_1",
    )?.revoked;

    // A parallel request that lost the rotation race presents the same token.
    const second = await refreshGrant(auth, RAW_REFRESH_TOKEN);

    assert.equal(second.response.status, 200, JSON.stringify(second.body));
    assert.ok(typeof second.body.refresh_token === "string");
    assert.notEqual(second.body.refresh_token, first.body.refresh_token);

    // Both forks stay usable — whichever Set-Cookie wins in the browser works.
    const firstFork = await refreshGrant(auth, first.body.refresh_token as string);
    assert.equal(firstFork.response.status, 200);
    const secondFork = await refreshGrant(auth, second.body.refresh_token as string);
    assert.equal(secondFork.response.status, 200);

    // The grace window runs from the FIRST rotation: replaying must not
    // re-stamp `revoked`, or the window could be extended forever.
    const originalRow = db.oauthRefreshToken.find((row) => row.id === "refresh_row_1");
    assert.deepEqual(originalRow?.revoked, revokedAtAfterFirstUse);
  });

  it("keeps the theft response for reuse after the grace window", async () => {
    const first = await refreshGrant(auth, RAW_REFRESH_TOKEN);
    assert.equal(first.response.status, 200);

    const originalRow = db.oauthRefreshToken.find((row) => row.id === "refresh_row_1");
    assert.ok(originalRow);
    originalRow.revoked = new Date(Date.now() - 2 * 60 * 1000);

    const reuse = await refreshGrant(auth, RAW_REFRESH_TOKEN);

    assert.equal(reuse.response.status, 400);
    assert.equal(reuse.body.error, "invalid_grant");
    // Family wipe: every refresh token the user holds for this client is gone.
    assert.equal(
      db.oauthRefreshToken.filter((row) => row.clientId === CLIENT_ID && row.userId === USER_ID)
        .length,
      0,
    );
  });
});
