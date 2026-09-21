// secrets-connections.e2e.test.ts — EVERY WAY A PROJECT CONNECTS TO A THIRD-PARTY API, end to end,
// against the deployed dummy-petshop (support/petshop.ts) — a real third party over the real network
// from the local worker and the deployed one alike (the plain pasted key is secrets.e2e.test.ts):
//   • `waitrose-session` — the username/password → session archetype (Waitrose's login; the
//     petshop's GraphQL login speaks the same wire shape): the secret holds ONLY the account
//     credential, its Durable Object logs in on first use and logs in again on 401.
//   • `oauth-refresh-token`, tokens brought by a trusted party — the OAuth story with the consent
//     walked by the test: discovery, code exchange, the secret, a call, expiry, rotation, revocation.
//   • OAuth, the first tokens obtained by the platform, confidential client — `itx.secrets.beginOAuth`
//     hands out the authorize URL; the provider redirects the human to the platform's one callback,
//     which admits only a member of the project; the exchange happens inside the secret's Durable
//     Object; HTTP Basic at the token endpoint.
//   • the same with a PUBLIC client — dynamically registered (RFC 7591), no secret, PKCE alone at the
//     exchange, `client_id` in the body on refresh: the MCP-client shape.
// The OAuth rows run in a DIRECTORY-REGISTERED project — a row on the console, not an ad-hoc
// context — exactly what a person would do. A SECRET IS ITS PATH (secrets.e2e.test.ts): every verb
// is keyed by `/secrets/<name>` and runs on that context, whose `secret` facet is the Durable Object
// below; its facts are on that path's log — `secret/set` (cross-posted to the root for the catalog)
// and `secret/refreshed { kind, ok, error? }`, one per strategy run. The material never leaves: the
// catalog, the facts and the logs carry the pin and the strategy kind, never a value.

import { expect, test } from "vitest";
import { adminCredentials, freshCtx, openItx, readAll, workerUrl } from "./support/client.ts";
import {
  petshopAuthorizationServer,
  petshopBaseUrl,
  petshopConnect,
  petshopExpireTokens,
  petshopMintClient,
  petshopRegisterPublicClient,
  petshopRevokeRefreshToken,
} from "./support/petshop.ts";
import { freshDnsSafeProjectSlug, registerProject } from "./support/project-host.ts";

/** A bearer call on the pets API through egress, the secret's `accessToken` as the placeholder —
 *  `secret` is the secret's path, what the placeholder spells (`itx` is the untyped capnweb stub
 *  `openItx` hands out). */
const bearerCall = async (itx: ReturnType<typeof openItx>, secret: string, path: string) => {
  const res = await itx.fetch(
    new Request(`${petshopBaseUrl()}${path}`, {
      headers: { authorization: `Bearer getSecret("${secret}", { field: "accessToken" })` },
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** The `secret/refreshed` facts on a SECRET's log (`itx.cd("/secrets/<name>")`), oldest first — the
 *  facet appends one per strategy run, before it answers the request that ran it. */
const refreshedFacts = async (secret: ReturnType<typeof openItx>): Promise<unknown[]> =>
  (await readAll(secret))
    .filter((e: any) => e.type === "events.iterate.com/secret/refreshed")
    .map((e: any) => e.payload);

test("waitrose-session: a username/password secret mints its session on first use, re-mints on 401, and the session works on the API — the password never leaves its Durable Object", async () => {
  const itx = openItx(freshCtx("secrets-waitrose"));
  const petshop = petshopBaseUrl();
  const username = `mum-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  // The secret: the account credential and NOTHING token-shaped. "correct-horse" is the fixture's
  // one accepted password (apps/dummy-petshop/src/graphql-login.ts).
  await itx.secrets.set(
    "/secrets/waitrose",
    { username, password: "correct-horse" },
    { urls: [petshop], refresh: { kind: "waitrose-session", graphqlUrl: `${petshop}/graphql` } },
  );
  expect(await itx.secrets.list()).toEqual([
    {
      path: "/secrets/waitrose",
      urls: [petshop],
      refresh: "waitrose-session",
      createdAt: expect.any(String),
    },
  ]);

  // First use: the material has no accessToken, so substitution misses, the secret's Durable Object
  // runs the NewSession login, and the retried request lands on the pets API as the logged-in account.
  expect(await bearerCall(itx, "/secrets/waitrose", "/api/me")).toMatchObject({
    status: 200,
    body: { sub: username, clientId: "graphql-session-login" },
  });

  // Force a real 401 (the epoch bump kills the stored session) and call again: re-login IS the
  // refresh — the object logs in again and the retry wins. `graphql-session-login` is the shop's ONE
  // client for its login door (apps/dummy-petshop/src/worker.ts), so this bump is deployment-wide:
  // safe because the account above is this run's alone and no other row in the suite logs in there.
  await petshopExpireTokens("graphql-session-login");
  const pets = await bearerCall(itx, "/secrets/waitrose", "/api/pets");
  expect(pets.status).toBe(200);
  expect(Array.isArray(pets.body.pets ?? pets.body)).toBe(true);

  // The two logins are two `secret/refreshed` facts on the secret's path — the first-use mint and
  // the re-mint on 401 — each the strategy's kind and the outcome.
  const secret = itx.cd("/secrets/waitrose");
  expect(await refreshedFacts(secret)).toEqual([
    { kind: "waitrose-session", ok: true },
    { kind: "waitrose-session", ok: true },
  ]);

  // Confinement: the fact on the secret's path and its cross-post on the root carry the pin and
  // the strategy's kind, never the password — and neither log holds it anywhere.
  const changePayload = { path: "/secrets/waitrose", urls: [petshop], refresh: "waitrose-session" };
  const setsOf = async (ctx: ReturnType<typeof openItx>) =>
    (await readAll(ctx))
      .filter((e: any) => e.type === "events.iterate.com/secret/set")
      .map((e: any) => e.payload);
  expect(await setsOf(secret)).toEqual([changePayload]);
  expect(await setsOf(itx)).toEqual([changePayload]);
  expect(JSON.stringify([await readAll(itx), await readAll(secret)])).not.toContain(
    "correct-horse",
  );
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
    "/secrets/petshop",
    { ...client, ...first },
    { urls: [petshop], refresh: { kind: "oauth-refresh-token", tokenEndpoint } },
  );
  expect(await itx.secrets.list()).toEqual([
    {
      path: "/secrets/petshop",
      urls: [petshop],
      refresh: "oauth-refresh-token",
      createdAt: expect.any(String),
    },
  ]);

  // 4. a call — the token is there, so no strategy runs
  expect(await bearerCall(itx, "/secrets/petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });
  const secret = itx.cd("/secrets/petshop");
  expect(await refreshedFacts(secret)).toEqual([]);

  // 5. expiry → refresh inside the DO → the retried call succeeds; the run is a fact on the path
  await petshopExpireTokens(client.clientId);
  expect(await bearerCall(itx, "/secrets/petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });
  expect(await refreshedFacts(secret)).toEqual([{ kind: "oauth-refresh-token", ok: true }]);

  // 6. rotation: the refresh in step 5 handed the DO a NEW refresh token, and it kept that one — so
  //    revoking the original changes nothing for the next expiry
  await petshopRevokeRefreshToken(first.refreshToken);
  await petshopExpireTokens(client.clientId);
  expect((await bearerCall(itx, "/secrets/petshop", "/api/pets")).status).toBe(200);

  // 7. revocation of the CURRENT refresh token: the next refresh grant is invalid_grant, and the
  //    caller gets the provider's 401 — the reason stays inside the DO. The current token is not
  //    readable (write-only), so it is refused by rotating the client secret's material instead:
  //    a re-set with a refresh token the provider never issued is the same failure the provider
  //    would give a revoked one.
  await itx.secrets.set(
    "/secrets/petshop",
    { ...client, accessToken: "expired-anyway", refreshToken: "revoked-or-never-issued" },
    { urls: [petshop], refresh: { kind: "oauth-refresh-token", tokenEndpoint } },
  );
  expect((await bearerCall(itx, "/secrets/petshop", "/api/me")).status).toBe(401);
  // the failed run is a fact too — the outcome and the provider's reason, never a token
  expect(await refreshedFacts(secret)).toEqual([
    { kind: "oauth-refresh-token", ok: true },
    { kind: "oauth-refresh-token", ok: true },
    { kind: "oauth-refresh-token", ok: false, error: expect.any(String) },
  ]);

  // 8. confinement — the root's log and the secret's
  const log = JSON.stringify([await readAll(itx), await readAll(secret)]);
  expect(log).not.toContain(first.accessToken);
  expect(log).not.toContain(first.refreshToken);
  expect(log).not.toContain(client.clientSecret);
  expect(log).not.toContain("revoked-or-never-issued");
  const elsewhere = await itx.fetch(
    new Request("https://example.com/", {
      headers: { authorization: 'Bearer getSecret("/secrets/petshop", { field: "accessToken" })' },
    }),
  );
  expect(elsewhere.status).toBe(502);
  const refusal = await elsewhere.text();
  expect(refusal).toContain(`pinned to ${petshop}`);
  expect(refusal).not.toContain(first.accessToken);
});

// THE FIRST TOKENS, obtained by the platform: `itx.secrets.beginOAuth` hands back the provider's
// authorize URL; the human consents there (the petshop's test-only `approve=1` shortcut stands in for
// the page); the provider redirects the human to the platform's one callback with the code; the
// callback admits only a signed-in member of the project (here the admin bearer, the lane's session),
// and the secret's Durable Object exchanges the code. From then on it is the ordinary
// `oauth-refresh-token` secret the story above proves. No code outside that object ever held a token
// — not even the test.
test("beginOAuth, confidential client, in a directory-registered project: authorize URL out, the code back at the platform's callback (a project member only), the exchange inside the secret's Durable Object; then a call, expiry and refresh", async () => {
  // a REAL project: a directory row (the console lists it), not an ad-hoc context
  const itx = openItx(await registerProject(freshDnsSafeProjectSlug("secrets-connect")));
  const petshop = petshopBaseUrl();
  const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint } =
    await petshopAuthorizationServer();
  const client = await petshopMintClient();

  const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/petshop", {
    authorizationEndpoint,
    tokenEndpoint,
    ...client,
    scope: "pets",
    urls: [petshop],
  });
  // nothing is on the catalog until the exchange succeeds — an abandoned attempt leaves no row
  expect(await itx.secrets.list()).toEqual([]);
  // a use before the callback is a clean 502: nothing to substitute, nothing to refresh with yet
  expect((await bearerCall(itx, "/secrets/petshop", "/api/me")).status).toBe(502);

  // the human's consent: the URL names the platform's callback and carries PKCE
  const authorize = new URL(authorizationUrl);
  const callback = workerUrl("/.secrets/oauth/callback");
  expect(authorize.searchParams.get("redirect_uri")).toBe(callback);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl).not.toContain(client.clientSecret);
  authorize.searchParams.set("approve", "1");
  const consent = await fetch(authorize, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(callback);
  expect(back.searchParams.get("code")).toBeTruthy();

  // the callback admits only a signed-in member of the project: no session is a 401, and the
  // attempt is still live afterwards (a stranger who saw the link cannot complete it, nor kill it)
  expect((await fetch(back)).status).toBe(401);
  // a forged state is refused before any session or Durable Object is consulted
  const forged = new URL(back);
  forged.searchParams.set("state", "not-signed-by-us");
  expect((await fetch(forged)).status).toBe(400);
  // the member's callback: the exchange happens inside the secret's Durable Object, and the catalog
  // learns of the secret now
  const member = { headers: { authorization: `Bearer ${adminCredentials().secret}` } };
  const done = await fetch(back, member);
  const said = await done.text();
  expect(done.status, said).toBe(200);
  expect(said).toContain("the secret /secrets/petshop of project");
  const row = {
    path: "/secrets/petshop",
    urls: [petshop],
    refresh: "oauth-refresh-token",
    createdAt: expect.any(String),
  };
  expect(await itx.secrets.list()).toEqual([row]);
  // the exchange's `secret/set` is on the secret's path — the platform's own write, no principal
  const secret = itx.cd("/secrets/petshop");
  const sets = (await readAll(secret)).filter(
    (e: any) => e.type === "events.iterate.com/secret/set",
  );
  expect(sets.map((e: any) => e.payload)).toEqual([
    { path: "/secrets/petshop", urls: [petshop], refresh: "oauth-refresh-token" },
  ]);
  // a replayed callback (a refreshed tab) completes idempotently: no second exchange, the same
  // one catalog row — never a 400 for a secret that is live
  expect((await fetch(back, member)).status).toBe(200);
  expect(await itx.secrets.list()).toEqual([row]);

  // now an ordinary oauth-refresh-token secret: a call, expiry, transparent refresh
  expect(await bearerCall(itx, "/secrets/petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });
  await petshopExpireTokens(client.clientId);
  expect(await bearerCall(itx, "/secrets/petshop", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId: client.clientId },
  });
  expect(await refreshedFacts(secret)).toEqual([{ kind: "oauth-refresh-token", ok: true }]);
  // and nothing token-shaped on either log
  const log = JSON.stringify([await readAll(itx), await readAll(secret)]);
  expect(log).not.toContain(client.clientSecret);
  expect(log).not.toContain("access_token");
});

// THE PUBLIC CLIENT: no secret anywhere — the provider registered the platform's callback as the one
// redirect URI, PKCE alone proves the exchange, and every later refresh identifies the client with
// `client_id` in the body. This is how an MCP client (and any DCR-registered client) connects.
test("beginOAuth, public client (RFC 7591 registration, PKCE alone, client_id in the body on refresh): the same flow, no secret involved at any point", async () => {
  const itx = openItx(await registerProject(freshDnsSafeProjectSlug("secrets-connect-public")));
  const petshop = petshopBaseUrl();
  const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint } =
    await petshopAuthorizationServer();
  const callback = workerUrl("/.secrets/oauth/callback");
  const { clientId } = await petshopRegisterPublicClient(callback);

  const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/petshop-public", {
    authorizationEndpoint,
    tokenEndpoint,
    clientId,
    scope: "pets",
    urls: [petshop],
  });
  const authorize = new URL(authorizationUrl);
  expect(authorize.searchParams.get("client_id")).toBe(clientId);
  expect(authorize.searchParams.get("redirect_uri")).toBe(callback);
  authorize.searchParams.set("approve", "1");
  const consent = await fetch(authorize, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(callback);
  const done = await fetch(back, {
    headers: { authorization: `Bearer ${adminCredentials().secret}` },
  });
  expect(done.status, await done.text()).toBe(200);

  expect(await itx.secrets.list()).toEqual([
    {
      path: "/secrets/petshop-public",
      urls: [petshop],
      refresh: "oauth-refresh-token",
      createdAt: expect.any(String),
    },
  ]);
  expect(await bearerCall(itx, "/secrets/petshop-public", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId },
  });
  // expiry → the refresh grant with client_id in the body (no Basic header to send) → 200
  await petshopExpireTokens(clientId);
  expect(await bearerCall(itx, "/secrets/petshop-public", "/api/me")).toMatchObject({
    status: 200,
    body: { clientId },
  });
  expect(await refreshedFacts(itx.cd("/secrets/petshop-public"))).toEqual([
    { kind: "oauth-refresh-token", ok: true },
  ]);
});
