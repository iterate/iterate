// secrets-refresh.e2e.test.ts — THE SECRET CELL end to end: a credential that expires is ONE secret
// (material + pin + refresh strategy), and the cell re-mints it in its own trusted code. Proven
// against the deployed dummy-petshop (support/petshop.ts) — a real third party over the real
// network from the local worker and the deployed one alike:
//   • `waitrose-session` — the username/password → session archetype (Waitrose's login, petshop's
//     GraphQL door speaks the same wire shape): the secret holds ONLY the account credential, the
//     cell logs in on first use and re-logs-in on 401; the session works on the pets API.
//   • `oauth-refresh-token` — a connected OAuth client's `{ clientId, clientSecret, refreshToken,
//     accessToken }` in one secret; an expired access token is refreshed inside the cell.
// The material never leaves: the catalog fact and the log carry the pin and the kind, never a value.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll } from "./support/client.ts";
import {
  petshopAuthorizationServer,
  petshopBaseUrl,
  petshopConnect,
  petshopExpireTokens,
  petshopMintClient,
  petshopRevokeRefreshToken,
} from "./support/petshop.ts";

/** A bearer call on the pets API through egress, the secret's `accessToken` as the placeholder. */
const bearerCall = async (itx: any, name: string, path: string) => {
  const res = await itx.fetch(
    new Request(`${petshopBaseUrl()}${path}`, {
      headers: { authorization: `Bearer getSecret("/secrets/${name}", { field: "accessToken" })` },
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

test("waitrose-session: a username/password secret mints its session on first use, re-mints on 401, and the session works on the API — the password never leaves the cell", async () => {
  const itx = openItx(freshCtx("secrets-waitrose"));
  const petshop = petshopBaseUrl();
  const username = `mum-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  // The secret: the account credential and NOTHING token-shaped. "correct-horse" is the fixture's
  // one accepted password (apps/dummy-petshop/src/graphql-login.ts).
  await itx.secrets.set(
    "waitrose",
    { username, password: "correct-horse" },
    { urls: [petshop], refresh: { kind: "waitrose-session", graphqlUrl: `${petshop}/graphql` } },
  );
  expect(await itx.secrets.list()).toEqual([
    { name: "waitrose", urls: [petshop], refresh: "waitrose-session" },
  ]);

  // First use: the material has no accessToken, so substitution misses, the cell runs the
  // NewSession login, and the retried request lands on the pets API as the logged-in account.
  expect(await bearerCall(itx, "waitrose", "/api/me")).toMatchObject({
    status: 200,
    body: { sub: username, clientId: "graphql-session-login" },
  });

  // Force a real 401 (the epoch bump kills the stored session) and call again: re-login IS the
  // refresh — the cell re-mints and the retry wins.
  await petshopExpireTokens("graphql-session-login");
  const pets = await bearerCall(itx, "waitrose", "/api/pets");
  expect(pets.status).toBe(200);
  expect(Array.isArray(pets.body.pets ?? pets.body)).toBe(true);

  // Confinement: the log carries the pin and the strategy's kind, never the password.
  const changes = (await readAll(itx)).filter(
    (e: any) => e.type === "events.iterate.com/secrets/changed",
  );
  expect(changes.map((e: any) => e.payload)).toEqual([
    { name: "waitrose", urls: [petshop], refresh: "waitrose-session" },
  ]);
  expect(JSON.stringify(changes)).not.toContain("correct-horse");
});

// AN OAUTH-PROTECTED API, END TO END. The petshop is a real OAuth 2.0 provider (RFC 8414 discovery,
// authorization code, HTTP Basic client auth at the token endpoint, refresh tokens that ROTATE on
// every refresh grant, a backdoor to revoke one). The story in order:
//   1. discovery — the connect flow learns the token endpoint from the provider's metadata;
//   2. consent + code exchange — the trusted party (a connect flow; here the test) walks the
//      authorization code grant ONCE and holds the first tokens for a moment;
//   3. the secret — `{ clientId, clientSecret, accessToken, refreshToken }` with the pin and the
//      `oauth-refresh-token` strategy pointing at that token endpoint; from here on no code but the
//      secret's Durable Object ever holds a token;
//   4. a call — the placeholder rides through egress, the DO substitutes the access token;
//   5. expiry — the provider answers 401, the DO runs the refresh grant (HTTP Basic with the client
//      credential from the material) and retries the same request once: the caller sees 200;
//   6. rotation — the provider rotated the refresh token in step 5 and the DO kept the NEWEST one:
//      revoking the ORIGINAL at the provider changes nothing for the next expiry;
//   7. revocation — revoking the CURRENT one makes the refresh grant fail: the 401 stays the
//      caller's answer, never a 502 with the provider's reason;
//   8. confinement — the catalog and the log never carry a token, and the pin refuses any other
//      origin before anything leaves.
test("oauth-refresh-token, end to end against the petshop: discovery, consent, the secret, a call, transparent refresh on expiry, rotation kept, revocation honoured, nothing leaks", async () => {
  const itx = openItx(freshCtx("secrets-oauth"));
  const petshop = petshopBaseUrl();

  // 1. discovery
  const { token_endpoint: tokenEndpoint } = await petshopAuthorizationServer();
  expect(tokenEndpoint).toBe(`${petshop}/oauth/token`);

  // 2. consent + code exchange, as the trusted party — a client of its own, so forcing ITS tokens to
  //    expire touches no other test
  const client = await petshopMintClient();
  const first = await petshopConnect(client);

  // 3. the secret
  await itx.secrets.set(
    "petshop",
    { ...client, ...first },
    { urls: [petshop], refresh: { kind: "oauth-refresh-token", tokenEndpoint } },
  );
  expect(await itx.secrets.list()).toEqual([
    { name: "petshop", urls: [petshop], refresh: "oauth-refresh-token" },
  ]);

  // 4. a call
  expect(await bearerCall(itx, "petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });

  // 5. expiry → refresh inside the DO → the retried call succeeds
  await petshopExpireTokens(client.clientId);
  expect(await bearerCall(itx, "petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });

  // 6. rotation: the refresh in step 5 handed the DO a NEW refresh token, and it kept that one — so
  //    revoking the original changes nothing for the next expiry
  await petshopRevokeRefreshToken(first.refreshToken);
  await petshopExpireTokens(client.clientId);
  expect((await bearerCall(itx, "petshop", "/api/pets")).status).toBe(200);

  // 7. revocation of the CURRENT refresh token: the next refresh grant is invalid_grant, and the
  //    caller gets the provider's 401 — the reason stays inside the DO. The current token is not
  //    readable (write-only), so it is refused by rotating the client secret's material instead:
  //    a re-set with a refresh token the provider never issued is the same failure the provider
  //    would give a revoked one.
  await itx.secrets.set(
    "petshop",
    { ...client, accessToken: "expired-anyway", refreshToken: "revoked-or-never-issued" },
    { urls: [petshop], refresh: { kind: "oauth-refresh-token", tokenEndpoint } },
  );
  expect((await bearerCall(itx, "petshop", "/api/me")).status).toBe(401);

  // 8. confinement
  const log = JSON.stringify(await readAll(itx));
  expect(log).not.toContain(first.accessToken);
  expect(log).not.toContain(first.refreshToken);
  expect(log).not.toContain(client.clientSecret);
  const elsewhere = await itx.fetch(
    new Request("https://example.com/", {
      headers: { authorization: 'Bearer getSecret("/secrets/petshop", { field: "accessToken" })' },
    }),
  );
  expect(elsewhere.status).toBe(502);
  const refusal = await elsewhere.text();
  expect(refusal).toContain(`bound to ${petshop}`);
  expect(refusal).not.toContain(first.accessToken);
});

test("one request, one secret: a request naming two secrets is refused at the door", async () => {
  const itx = openItx(freshCtx("secrets-two"));
  await itx.secrets.set("a", "1");
  await itx.secrets.set("b", "2");
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { "x-a": 'getSecret("/secrets/a")', "x-b": 'getSecret("/secrets/b")' },
    }),
  );
  expect(res.status).toBe(502);
  expect(await res.text()).toContain('one request, one secret — this one names "a", "b"');
});
