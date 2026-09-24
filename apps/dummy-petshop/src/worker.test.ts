/**
 * Unit tests for the whole pet-shop HTTP surface, run in plain Node: the
 * real route handlers and the real PetshopStateDurableObject, with only two
 * fakes — an in-memory storage map behind the DO (test/shop.ts), and the vitest alias that
 * swaps `cloudflare:workers` for src/test/cloudflare-workers-shim.ts.
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { expect, onTestFinished, test, vi } from "vitest";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";
import { pkceS256 } from "./seal.ts";
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  type PetshopState,
} from "./state.ts";
import { makeShop, ORIGIN, type Shop } from "./test/shop.ts";

/** What POST /__backdoor/clients returns. */
type MintedClient = { clientId: string; clientSecret: string };

const REDIRECT_URI = "https://project.example/integrations/petshop/callback";

test("index: GET / documents the surface and the seeded client", async () => {
  const shop = makeShop();
  const response = await shop.call("/");
  expect(response).toMatchObject({ status: 200 });
  const text = await response.text();
  expect(text).toContain("/oauth/token");
  expect(text).toContain(DEFAULT_CLIENT_ID);
});

test("index: unknown routes 404", async () => {
  const shop = makeShop();
  expect(await shop.call("/nope")).toMatchObject({ status: 404 });
});

test("authorize: rejects unknown client_id with a minting hint", async () => {
  const shop = makeShop();
  const response = await shop.call(
    `/oauth/authorize?client_id=who&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  );
  expect(response).toMatchObject({ status: 400 });
  expect(await response.text()).toContain("/__backdoor/clients");
});

test("authorize: rejects a relative redirect_uri", async () => {
  const shop = makeShop();
  const response = await shop.call(
    `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=/not-absolute`,
  );
  expect(response).toMatchObject({ status: 400 });
});

test("authorize: renders the consent form with round-tripped hidden fields", async () => {
  const shop = makeShop();
  const response = await shop.call(
    `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=xyz`,
  );
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  const page = await response.text();
  expect(page).toContain(`name="client_id" value="${DEFAULT_CLIENT_ID}"`);
  expect(page).toContain(`name="state" value="xyz"`);
  expect(page).toContain("Approve");
});

test("authorize: approve=1 skips consent and redirects with code + state", async () => {
  const shop = makeShop();
  const response = await shop.call(
    `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=abc&approve=1&user=Jonas`,
  );
  expect(response).toMatchObject({ status: 302 });
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get("state")).toBe("abc");
  expect(location.searchParams.get("code")).toBeTruthy();
});

test("token exchange: authorization_code flow yields tokens that work on the API", async () => {
  const shop = makeShop();
  const tokens = await connect(shop, { user: "Jonas" });
  expect(tokens).toMatchObject({ expires_in: DEFAULT_ACCESS_TTL_SECONDS });

  const me = await shop.call("/api/me", bearer(tokens.access_token));
  expect(me).toMatchObject({ status: 200 });
  expect(await me.json()).toMatchObject({ sub: "Jonas", clientId: DEFAULT_CLIENT_ID });

  const pets = await shop.call("/api/pets", bearer(tokens.access_token));
  expect(await pets.json()).toMatchObject({ owner: "Jonas" });
});

test("token exchange: authorization codes are single-use (a replayed code is rejected)", async () => {
  const shop = makeShop();
  const location = await approve(shop, {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  const code = location.searchParams.get("code") ?? "";
  const body = { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI };
  const first = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body,
  });
  expect(first).toMatchObject({ status: 200 });
  const replay = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body,
  });
  expect(replay).toMatchObject({ status: 400 });
  expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
});

test("token exchange: the API rejects requests without a live bearer token", async () => {
  const shop = makeShop();
  expect(await shop.call("/api/me")).toMatchObject({ status: 401 });
  expect(await shop.call("/api/me", bearer("garbage"))).toMatchObject({ status: 401 });
});

test("token exchange: requires HTTP Basic client auth", async () => {
  const shop = makeShop();
  const location = await approve(shop, {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: location.searchParams.get("code") ?? "",
    redirect_uri: REDIRECT_URI,
  });
  const bare = await shop.call("/oauth/token", { method: "POST", body });
  expect(bare).toMatchObject({ status: 401 });
  expect(bare.headers.get("www-authenticate")).toContain("Basic");
  const wrong = await shop.call("/oauth/token", {
    method: "POST",
    headers: { authorization: basicAuth(DEFAULT_CLIENT_ID, "wrong-secret") },
    body,
  });
  expect(wrong).toMatchObject({ status: 401 });
});

// The rejection grammar: every row approves a fresh code, then exchanges
// with one thing wrong. `expectedStatus` is asserted only where the
// original test pinned it.
test.for([
  {
    name: "a code minted for one client cannot be exchanged by another",
    useMintedClient: true,
    body: (code: string) => ({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
    expectedStatus: 400,
    expectedError: "invalid_grant",
  },
  {
    name: "re-checks redirect_uri at exchange time",
    body: (code: string) => ({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://attacker.example/callback",
    }),
    expectedStatus: 400,
    expectedError: "invalid_grant",
  },
  {
    name: "rejects garbage codes",
    body: () => ({
      grant_type: "authorization_code",
      code: "garbage",
      redirect_uri: REDIRECT_URI,
    }),
    expectedError: "invalid_grant",
  },
  {
    name: "rejects unknown grant types",
    body: () => ({ grant_type: "password" }),
    expectedError: "unsupported_grant_type",
  },
])("token exchange: $name", async ({ body, expectedError, expectedStatus, useMintedClient }) => {
  const shop = makeShop();
  const location = await approve(shop, {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  const client = useMintedClient
    ? await (await shop.call("/__backdoor/clients", postJson({}))).json<MintedClient>()
    : { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };
  const response = await exchange(shop, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    body: body(location.searchParams.get("code") ?? ""),
  });
  if (expectedStatus !== undefined) {
    expect(response).toMatchObject({ status: expectedStatus });
  }
  expect(await response.json()).toMatchObject({ error: expectedError });
});

test("token exchange: rejects expired codes", async () => {
  const shop = makeShop();
  const location = await approve(shop, {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(Date.now() + 121_000);
  const expired = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body: {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
    },
  });
  expect(await expired.json()).toMatchObject({ error: "invalid_grant" });
});

test("token exchange: backdoor-minted clients control their own access-token TTL", async () => {
  const shop = makeShop();
  const minted = await (
    await shop.call("/__backdoor/clients", postJson({ accessTokenTtlSeconds: 7 }))
  ).json<MintedClient>();
  const tokens = await connect(shop, minted);
  expect(tokens).toMatchObject({ expires_in: 7 });
});

test("expiry, refresh, revocation: access tokens expire naturally; refresh mints a working replacement", async () => {
  const shop = makeShop();
  const tokens = await connect(shop);
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(Date.now() + (DEFAULT_ACCESS_TTL_SECONDS + 1) * 1000);
  expect(await shop.call("/api/me", bearer(tokens.access_token))).toMatchObject({ status: 401 });

  const refreshed = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
  });
  expect(refreshed).toMatchObject({ status: 200 });
  const next = await refreshed.json<{ access_token: string }>();
  expect(await shop.call("/api/me", bearer(next.access_token))).toMatchObject({ status: 200 });
});

test("expiry, refresh, revocation: backdoor expire-tokens kills outstanding access tokens but not refresh tokens", async () => {
  const shop = makeShop();
  const tokens = await connect(shop);
  expect(
    await shop.call("/__backdoor/expire-tokens", postJson({ clientId: DEFAULT_CLIENT_ID })),
  ).toMatchObject({ status: 200 });
  expect(await shop.call("/api/me", bearer(tokens.access_token))).toMatchObject({ status: 401 });

  const refreshed = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
  });
  expect(refreshed).toMatchObject({ status: 200 });
});

test("expiry, refresh, revocation: expiring one client's tokens leaves concurrently active clients alone", async () => {
  const shop = makeShop();
  const first = await connect(shop);
  const otherClient = await (
    await shop.call("/__backdoor/clients", postJson({}))
  ).json<MintedClient>();
  const other = await connect(shop, otherClient);

  expect(
    await shop.call("/__backdoor/expire-tokens", postJson({ clientId: DEFAULT_CLIENT_ID })),
  ).toMatchObject({ status: 200 });

  expect(await shop.call("/api/me", bearer(first.access_token))).toMatchObject({ status: 401 });
  expect(await shop.call("/api/me", bearer(other.access_token))).toMatchObject({ status: 200 });
});

test("expiry, refresh, revocation: expire-tokens requires an explicit client so it cannot globally invalidate tests", async () => {
  const shop = makeShop();
  const response = await shop.call("/__backdoor/expire-tokens", { method: "POST" });
  expect(response).toMatchObject({ status: 400 });
  expect(await response.json()).toMatchObject({ error: "invalid_request" });
});

test("expiry, refresh, revocation: backdoor revoke-refresh-token kills exactly that refresh token", async () => {
  const shop = makeShop();
  const tokens = await connect(shop);
  const revoke = await shop.call(
    "/__backdoor/revoke-refresh-token",
    postJson({ refreshToken: tokens.refresh_token }),
  );
  expect(revoke).toMatchObject({ status: 200 });
  const refreshed = await exchange(shop, {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
  });
  expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });

  const junk = await shop.call(
    "/__backdoor/revoke-refresh-token",
    postJson({ refreshToken: "junk" }),
  );
  expect(junk).toMatchObject({ status: 400 });
});

test("expiry, refresh, revocation: a refresh token cannot be used by a different client", async () => {
  const shop = makeShop();
  const tokens = await connect(shop);
  const other = await (await shop.call("/__backdoor/clients", postJson({}))).json<MintedClient>();
  const response = await exchange(shop, {
    clientId: other.clientId,
    clientSecret: other.clientSecret,
    body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
  });
  expect(await response.json()).toMatchObject({ error: "invalid_grant" });
});

// Legacy login: email + password, and no refresh grant.
test("legacy login: email + the well-known password yields a working short-TTL token", async () => {
  const shop = makeShop();
  const response = await shop.call(
    "/api/legacy-login",
    postJson({ email: "mum@example.com", password: "correct-horse" }),
  );
  expect(response).toMatchObject({ status: 200 });
  const { accessToken, expiresInSeconds } = await response.json<{
    accessToken: string;
    expiresInSeconds: number;
  }>();
  expect(expiresInSeconds).toBe(DEFAULT_ACCESS_TTL_SECONDS);
  const me = await shop.call("/api/me", bearer(accessToken));
  expect(await me.json()).toMatchObject({ sub: "mum@example.com", clientId: "legacy-login" });
});

test("legacy login: rejects wrong passwords and missing emails", async () => {
  const shop = makeShop();
  expect(
    await shop.call("/api/legacy-login", postJson({ email: "a@b.c", password: "nope" })),
  ).toMatchObject({ status: 401 });
  expect(
    await shop.call("/api/legacy-login", postJson({ password: "correct-horse" })),
  ).toMatchObject({ status: 401 });
});

test("legacy login: backdoor expire-tokens kills legacy tokens too", async () => {
  const shop = makeShop();
  const { accessToken } = await (
    await shop.call("/api/legacy-login", postJson({ email: "a@b.c", password: "correct-horse" }))
  ).json<{ accessToken: string }>();
  await shop.call("/__backdoor/expire-tokens", postJson({ clientId: "legacy-login" }));
  expect(await shop.call("/api/me", bearer(accessToken))).toMatchObject({ status: 401 });
});

// The token endpoint outage is scheduled through the backdoor.
test("token endpoint outage: fails the next N token calls, then recovers", async () => {
  const shop = makeShop();
  const otherClient = await (
    await shop.call("/__backdoor/clients", postJson({}))
  ).json<{ clientId: string; clientSecret: string }>();
  expect(
    await shop.call(
      "/__backdoor/fail-token-endpoint",
      postJson({ clientId: DEFAULT_CLIENT_ID, times: 2 }),
    ),
  ).toMatchObject({ status: 200 });
  // A concurrent client's call reaches the real endpoint and cannot consume
  // the default client's scheduled failures.
  expect(
    await exchange(shop, {
      ...otherClient,
      body: { grant_type: "refresh_token", refresh_token: "irrelevant" },
    }),
  ).toMatchObject({ status: 400 });
  const attempt = () =>
    exchange(shop, {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      body: { grant_type: "refresh_token", refresh_token: "irrelevant" },
    });
  expect(await attempt()).toMatchObject({ status: 500 });
  expect(await attempt()).toMatchObject({ status: 500 });
  // Third call reaches the real endpoint (and fails normally on the junk token).
  expect(await attempt()).toMatchObject({ status: 400 });
  expect(
    (await backdoorState(shop)).tokenEndpointFailuresRemainingByClient[DEFAULT_CLIENT_ID],
  ).toBeUndefined();
});

test("token endpoint outage: requires a client and rejects a non-integer times", async () => {
  const shop = makeShop();
  expect(await shop.call("/__backdoor/fail-token-endpoint", postJson({ times: 1 }))).toMatchObject({
    status: 400,
  });
  expect(
    await shop.call(
      "/__backdoor/fail-token-endpoint",
      postJson({ clientId: DEFAULT_CLIENT_ID, times: "many" }),
    ),
  ).toMatchObject({ status: 400 });
});

test("webhooks: fires HMAC-signed webhooks the receiver can verify", async () => {
  const shop = makeShop();
  const receiver = await startReceiver();
  try {
    const fire = await shop.call(
      "/__backdoor/webhooks/fire",
      postJson({ url: receiver.url, event: { event: "pet.adopted", petId: "pet-1" } }),
    );
    expect(fire).toMatchObject({ status: 200 });
    const result = await fire.json<{ status: number; signature: string }>();
    expect(result).toMatchObject({ status: 200 });

    const delivery = receiver.received[0];
    expect(JSON.parse(delivery.body)).toEqual({ event: "pet.adopted", petId: "pet-1" });
    const { webhookSigningSecret } = await backdoorState(shop);
    expect(delivery).toMatchObject({ signature: hexHmac(webhookSigningSecret, delivery.body) });
    expect(result).toMatchObject({ signature: delivery.signature });
  } finally {
    await receiver.close();
  }
});

test("webhooks: badSignature deliveries fail verification; rotation switches the key", async () => {
  const shop = makeShop();
  const receiver = await startReceiver();
  try {
    await shop.call(
      "/__backdoor/webhooks/fire",
      postJson({ url: receiver.url, badSignature: true }),
    );
    const oldSecret = (await backdoorState(shop)).webhookSigningSecret;
    expect(receiver.received[0]).not.toMatchObject({
      signature: hexHmac(oldSecret, receiver.received[0].body),
    });

    const rotated = await (
      await shop.call("/__backdoor/rotate-signing-secret", { method: "POST" })
    ).json<{ webhookSigningSecret: string }>();
    expect(rotated).not.toMatchObject({ webhookSigningSecret: oldSecret });
    await shop.call("/__backdoor/webhooks/fire", postJson({ url: receiver.url }));
    expect(receiver.received[1]).toMatchObject({
      signature: hexHmac(rotated.webhookSigningSecret, receiver.received[1].body),
    });
  } finally {
    await receiver.close();
  }
});

test("webhooks: reports unreachable targets instead of throwing, and rejects bad URLs", async () => {
  const shop = makeShop();
  const dead = await (
    await shop.call("/__backdoor/webhooks/fire", postJson({ url: "http://127.0.0.1:1/hook" }))
  ).json<{ status: number }>();
  expect(dead).toMatchObject({ status: 0 });
  expect(
    await shop.call("/__backdoor/webhooks/fire", postJson({ url: "not-a-url" })),
  ).toMatchObject({ status: 400 });
});

// The socket path (WebSocketPair + 101) only exists in workerd, so the Node
// unit tests can only assert the 426 guard; the live e2e drives the sockets.
test.each(["/gateway", "/gateway-header", "/gateway-subprotocol"])(
  "gateway routes: GET %s without an Upgrade header is 426, not a socket",
  async (path) => {
    const shop = makeShop();
    const response = await shop.call(path);
    expect(response).toMatchObject({ status: 426 });
    expect(await response.json()).toMatchObject({ error: "upgrade_required" });
  },
);

test("backdoor lock: requires x-petshop-backdoor when PETSHOP_BACKDOOR_SECRET is set", async () => {
  const shop = makeShop({ backdoorSecret: "hunter2" });
  expect(await shop.call("/__backdoor/state")).toMatchObject({ status: 403 });
  expect(
    await shop.call("/__backdoor/state", { headers: { "x-petshop-backdoor": "hunter2" } }),
  ).toMatchObject({ status: 200 });
  // The rest of the shop stays open.
  expect(await shop.call("/")).toMatchObject({ status: 200 });
});

// MCP OAuth: RFC 9728, 8414 and 7591, plus PKCE.
test("mcp oauth: unauthorized /mcp answers 401 pointing at protected-resource metadata", async () => {
  const shop = makeShop();
  const response = await shop.call("/mcp", { method: "POST" });
  expect(response).toMatchObject({ status: 401 });
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
});

test("mcp oauth: discovery documents name the resource, auth server, and endpoints", async () => {
  const shop = makeShop();
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    expect(await (await shop.call(path)).json()).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
  }
  const as = await (await shop.call("/.well-known/oauth-authorization-server")).json();
  expect(as).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
  });
});

test("mcp oauth: dynamic registration mints a confidential client", async () => {
  const shop = makeShop();
  const response = await shop.call("/oauth/register", {
    ...postJson({ redirect_uris: [REDIRECT_URI], client_name: "iterate" }),
  });
  expect(response).toMatchObject({ status: 201 });
  const client = (await response.json()) as { client_id: string; client_secret: string };
  expect(client.client_id).toMatch(/^petshop-client-/);
  expect(client.client_secret).toBeTruthy();
  // The minted client is real: it works as a token-endpoint credential.
  const tokens = await connect(shop, {
    clientId: client.client_id,
    clientSecret: client.client_secret,
  });
  expect(tokens.access_token).toBeTruthy();
});

test("mcp oauth: register with no absolute redirect_uri is rejected", async () => {
  const shop = makeShop();
  const response = await shop.call("/oauth/register", { ...postJson({ redirect_uris: [] }) });
  expect(response).toMatchObject({ status: 400 });
  expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
});

test("mcp oauth: full PKCE code flow: register → authorize(challenge) → token(verifier) → /mcp", async () => {
  const shop = makeShop();
  const client = (await (
    await shop.call("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
  ).json()) as { client_id: string; client_secret: string };

  const verifier = "verifier-" + "a".repeat(50);
  const challenge = await pkceS256(verifier);
  const location = await approve(shop, {
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
  });

  // The right verifier redeems the code.
  const good = await exchange(shop, {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    body: {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  expect(good).toMatchObject({ status: 200 });
  const tokens = (await good.json()) as { access_token: string };
  const mcp = await shop.call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    }),
  });
  expect(mcp).toMatchObject({ status: 200 });
});

test("mcp oauth: a code minted with a challenge is not redeemable without the verifier", async () => {
  const shop = makeShop();
  const client = (await (
    await shop.call("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
  ).json()) as { client_id: string; client_secret: string };
  const challenge = await pkceS256("the-real-verifier-" + "z".repeat(40));
  const location = await approve(shop, {
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
  });
  const missing = await exchange(shop, {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    body: {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
    },
  });
  expect(missing).toMatchObject({ status: 400 });
  expect(await missing.json()).toMatchObject({ error: "invalid_grant" });
});

test("mcp oauth: public client (token_endpoint_auth_method none): no secret, client_id + PKCE at token", async () => {
  const shop = makeShop();
  const registration = (await (
    await shop.call("/oauth/register", {
      ...postJson({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
  // A public client gets no secret back.
  expect(registration.client_secret).toBeUndefined();
  expect(registration).toMatchObject({ token_endpoint_auth_method: "none" });

  const verifier = "verifier-" + "p".repeat(50);
  const location = await approve(shop, {
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: await pkceS256(verifier),
  });
  // No Basic auth — the client identifies itself with client_id in the body.
  const token = await shop.call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(token).toMatchObject({ status: 200 });
  const tokens = (await token.json()) as { access_token: string; refresh_token: string };
  expect(await shop.call("/api/me", bearer(tokens.access_token))).toMatchObject({ status: 200 });

  // Public-client refresh: client_id in the body, still no Basic auth.
  const refreshed = await shop.call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: tokens.refresh_token,
    }),
  });
  expect(refreshed).toMatchObject({ status: 200 });
});

test("mcp oauth: a public client with no PKCE verifier is rejected", async () => {
  const shop = makeShop();
  const registration = (await (
    await shop.call("/oauth/register", {
      ...postJson({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string };
  // No code_challenge at authorize → the public code has no PKCE binding.
  const location = await approve(shop, {
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
  });
  const token = await shop.call("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(token).toMatchObject({ status: 400 });
  expect(await token.json()).toMatchObject({ error: "invalid_grant" });
});

test("mcp oauth: a dynamically-registered client is pinned to its redirect URIs", async () => {
  const shop = makeShop();
  const client = (await (
    await shop.call("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
  ).json()) as { client_id: string };
  // An unregistered redirect_uri is refused (no open redirect).
  const rejected = await shop.call(
    `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/steal")}&approve=1`,
  );
  expect(rejected).toMatchObject({ status: 400 });
  expect(await rejected.json()).toMatchObject({ error: "invalid_request" });
});

const basicAuth = (clientId: string, clientSecret: string) =>
  `Basic ${btoa(`${clientId}:${clientSecret}`)}`;

async function approve(
  shop: Shop,
  fields: {
    client_id: string;
    redirect_uri: string;
    state?: string;
    user?: string;
    code_challenge?: string;
  },
): Promise<URL> {
  const response = await shop.call("/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({ state: "", user: "", ...fields }),
  });
  expect(response).toMatchObject({ status: 302 });
  return new URL(response.headers.get("location") ?? "");
}

async function exchange(
  shop: Shop,
  input: { clientId: string; clientSecret: string; body: Record<string, string> },
): Promise<Response> {
  return shop.call("/oauth/token", {
    method: "POST",
    headers: { authorization: basicAuth(input.clientId, input.clientSecret) },
    body: new URLSearchParams(input.body),
  });
}

/** Full consent → code → token dance; returns the token response body. */
async function connect(
  shop: Shop,
  input: { clientId?: string; clientSecret?: string; user?: string } = {},
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const clientId = input.clientId || DEFAULT_CLIENT_ID;
  const clientSecret = input.clientSecret || DEFAULT_CLIENT_SECRET;
  const location = await approve(shop, {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    user: input.user || "",
  });
  const response = await exchange(shop, {
    clientId,
    clientSecret,
    body: {
      grant_type: "authorization_code",
      code: location.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
    },
  });
  expect(response).toMatchObject({ status: 200 });
  return response.json();
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function backdoorState(shop: Shop): Promise<PetshopState> {
  const response = await shop.call("/__backdoor/state");
  expect(response).toMatchObject({ status: 200 });
  return response.json();
}

const postJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A local HTTP sink capturing exactly what the shop delivered. */
async function startReceiver() {
  const received: { body: string; signature: string | null }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        body,
        signature: request.headers["x-petshop-signature-256"]?.toString() ?? null,
      });
      response.writeHead(200).end("ok");
    });
  });
  const port = await listenOnFetchSafePort(server);
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const hexHmac = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
