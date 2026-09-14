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
  petshopBaseUrl,
  petshopConnect,
  petshopExpireTokens,
  petshopMintClient,
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

test("oauth-refresh-token: a connected client's tokens are one secret; an expired access token is refreshed inside the cell; the pin refuses any other origin before anything leaves", async () => {
  const itx = openItx(freshCtx("secrets-oauth"));
  const petshop = petshopBaseUrl();
  // The connect half, run ONCE by the trusted party (a connect flow, a human): a client of its own
  // (so forcing its tokens to expire touches no other test) and its first tokens.
  const client = await petshopMintClient();
  const tokens = await petshopConnect(client);
  await itx.secrets.set(
    "petshop",
    { ...client, ...tokens },
    {
      urls: [petshop],
      refresh: { kind: "oauth-refresh-token", tokenEndpoint: `${petshop}/oauth/token` },
    },
  );

  expect(await bearerCall(itx, "petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });
  // Force a real 401: the cell runs the refresh_token grant (HTTP Basic, the client credential from
  // the material) and the retry carries the new access token.
  await petshopExpireTokens(client.clientId);
  expect(await bearerCall(itx, "petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });

  // A secret outside its pin is refused at the door — naming the pin, never the value.
  const elsewhere = await itx.fetch(
    new Request("https://example.com/", {
      headers: { authorization: 'Bearer getSecret("/secrets/petshop", { field: "accessToken" })' },
    }),
  );
  expect(elsewhere.status).toBe(502);
  const refusal = await elsewhere.text();
  expect(refusal).toContain(`bound to ${petshop}`);
  expect(refusal).not.toContain(tokens.accessToken);
});

test("a refresh the provider refuses leaves the 401 as the caller's answer — never a 502 with the reason inside the cell", async () => {
  const itx = openItx(freshCtx("secrets-refresh-refused"));
  const petshop = petshopBaseUrl();
  const client = await petshopMintClient();
  const tokens = await petshopConnect(client);
  await itx.secrets.set(
    "petshop",
    { ...client, accessToken: tokens.accessToken, refreshToken: "bogus" },
    {
      urls: [petshop],
      refresh: { kind: "oauth-refresh-token", tokenEndpoint: `${petshop}/oauth/token` },
    },
  );
  expect((await bearerCall(itx, "petshop", "/api/me")).status).toBe(200);
  await petshopExpireTokens(client.clientId);
  expect((await bearerCall(itx, "petshop", "/api/me")).status).toBe(401);
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
