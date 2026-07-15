/**
 * Unit tests for the whole pet-shop HTTP surface, run in plain Node: the
 * real route handlers and the real PetshopStateDurableObject, with only two
 * fakes — an in-memory storage map behind the DO, and the vitest alias that
 * swaps `cloudflare:workers` for src/test/cloudflare-workers-shim.ts.
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { seedPets } from "./pets.ts";
import { pkceS256, randomSealKey } from "./seal.ts";
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  PetshopStateDurableObject,
  type PetshopState,
} from "./state.ts";
import { handlePetshopRequest, type PetshopDeps } from "./worker.ts";

/** One shop "environment": the app over the real state class and an in-memory storage fake. */
type Shop = (path: string, init?: RequestInit) => Promise<Response>;

/** What POST /__backdoor/clients returns. */
type MintedClient = { clientId: string; clientSecret: string };

function makeShop(backdoorSecret?: string): Shop {
  const blobs = new Map<string, unknown>();
  // Clone on both sides like real DO storage does, so nothing survives by
  // reference identity.
  const storage = {
    get: async (key: string) => structuredClone(blobs.get(key)),
    put: async (key: string, value: unknown) => void blobs.set(key, structuredClone(value)),
  };
  const deps: PetshopDeps = {
    state: new PetshopStateDurableObject({ storage } as unknown as DurableObjectState, {}),
    sealKey: randomSealKey(),
    backdoorSecret,
    pets: seedPets(),
  };
  return (path, init) =>
    handlePetshopRequest(new Request(`https://petshop.example${path}`, init), deps);
}

const REDIRECT_URI = "https://project.example/integrations/petshop/callback";

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
  const response = await shop("/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({ state: "", user: "", ...fields }),
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "");
}

async function exchange(
  shop: Shop,
  input: { clientId: string; clientSecret: string; body: Record<string, string> },
): Promise<Response> {
  return shop("/oauth/token", {
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
  const clientId = input.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = input.clientSecret ?? DEFAULT_CLIENT_SECRET;
  const location = await approve(shop, {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    user: input.user ?? "",
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
  expect(response.status).toBe(200);
  return response.json();
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function backdoorState(shop: Shop): Promise<PetshopState> {
  const response = await shop("/__backdoor/state");
  expect(response.status).toBe(200);
  return response.json();
}

const postJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

afterEach(() => {
  vi.useRealTimers();
});

describe("index", () => {
  test("GET / documents the surface and the seeded client", async () => {
    const shop = makeShop();
    const response = await shop("/");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("/oauth/token");
    expect(text).toContain(DEFAULT_CLIENT_ID);
  });

  test("unknown routes 404", async () => {
    const shop = makeShop();
    expect((await shop("/nope")).status).toBe(404);
  });
});

describe("authorize", () => {
  test("rejects unknown client_id with a minting hint", async () => {
    const shop = makeShop();
    const response = await shop(
      `/oauth/authorize?client_id=who&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("/__backdoor/clients");
  });

  test("rejects a relative redirect_uri", async () => {
    const shop = makeShop();
    const response = await shop(
      `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=/not-absolute`,
    );
    expect(response.status).toBe(400);
  });

  test("renders the consent form with round-tripped hidden fields", async () => {
    const shop = makeShop();
    const response = await shop(
      `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=xyz`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain(`name="client_id" value="${DEFAULT_CLIENT_ID}"`);
    expect(page).toContain(`name="state" value="xyz"`);
    expect(page).toContain("Approve");
  });

  test("approve=1 skips consent and redirects with code + state", async () => {
    const shop = makeShop();
    const response = await shop(
      `/oauth/authorize?client_id=${DEFAULT_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=abc&approve=1&user=Jonas`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code")).toBeTruthy();
  });
});

describe("token exchange", () => {
  test("authorization_code flow yields tokens that work on the API", async () => {
    const shop = makeShop();
    const tokens = await connect(shop, { user: "Jonas" });
    expect(tokens.expires_in).toBe(DEFAULT_ACCESS_TTL_SECONDS);

    const me = await shop("/api/me", bearer(tokens.access_token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ sub: "Jonas", clientId: DEFAULT_CLIENT_ID });

    const pets = await shop("/api/pets", bearer(tokens.access_token));
    expect(await pets.json()).toMatchObject({ owner: "Jonas" });
  });

  test("authorization codes are single-use (a replayed code is rejected)", async () => {
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
    expect(first.status).toBe(200);
    const replay = await exchange(shop, {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      body,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("the API rejects requests without a live bearer token", async () => {
    const shop = makeShop();
    expect((await shop("/api/me")).status).toBe(401);
    expect((await shop("/api/me", bearer("garbage"))).status).toBe(401);
  });

  test("requires HTTP Basic client auth", async () => {
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
    const bare = await shop("/oauth/token", { method: "POST", body });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain("Basic");
    const wrong = await shop("/oauth/token", {
      method: "POST",
      headers: { authorization: basicAuth(DEFAULT_CLIENT_ID, "wrong-secret") },
      body,
    });
    expect(wrong.status).toBe(401);
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
  ])("$name", async ({ body, expectedError, expectedStatus, useMintedClient }) => {
    const shop = makeShop();
    const location = await approve(shop, {
      client_id: DEFAULT_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    const client = useMintedClient
      ? await (await shop("/__backdoor/clients", postJson({}))).json<MintedClient>()
      : { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };
    const response = await exchange(shop, {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      body: body(location.searchParams.get("code") ?? ""),
    });
    if (expectedStatus !== undefined) {
      expect(response.status).toBe(expectedStatus);
    }
    expect(await response.json()).toMatchObject({ error: expectedError });
  });

  test("rejects expired codes", async () => {
    const shop = makeShop();
    const location = await approve(shop, {
      client_id: DEFAULT_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
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

  test("backdoor-minted clients control their own access-token TTL", async () => {
    const shop = makeShop();
    const minted = await (
      await shop("/__backdoor/clients", postJson({ accessTokenTtlSeconds: 7 }))
    ).json<MintedClient>();
    const tokens = await connect(shop, minted);
    expect(tokens.expires_in).toBe(7);
  });
});

describe("expiry, refresh, revocation", () => {
  test("access tokens expire naturally; refresh mints a working replacement", async () => {
    const shop = makeShop();
    const tokens = await connect(shop);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (DEFAULT_ACCESS_TTL_SECONDS + 1) * 1000);
    expect((await shop("/api/me", bearer(tokens.access_token))).status).toBe(401);

    const refreshed = await exchange(shop, {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect((await shop("/api/me", bearer(next.access_token))).status).toBe(200);
  });

  test("backdoor expire-tokens kills outstanding access tokens but not refresh tokens", async () => {
    const shop = makeShop();
    const tokens = await connect(shop);
    expect((await shop("/__backdoor/expire-tokens", { method: "POST" })).status).toBe(200);
    expect((await shop("/api/me", bearer(tokens.access_token))).status).toBe(401);

    const refreshed = await exchange(shop, {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status).toBe(200);
  });

  test("backdoor revoke-refresh-token kills exactly that refresh token", async () => {
    const shop = makeShop();
    const tokens = await connect(shop);
    const revoke = await shop(
      "/__backdoor/revoke-refresh-token",
      postJson({ refreshToken: tokens.refresh_token }),
    );
    expect(revoke.status).toBe(200);
    const refreshed = await exchange(shop, {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });

    const junk = await shop("/__backdoor/revoke-refresh-token", postJson({ refreshToken: "junk" }));
    expect(junk.status).toBe(400);
  });

  test("a refresh token cannot be used by a different client", async () => {
    const shop = makeShop();
    const tokens = await connect(shop);
    const other = await (await shop("/__backdoor/clients", postJson({}))).json<MintedClient>();
    const response = await exchange(shop, {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("legacy login (email + password, no refresh grant)", () => {
  test("email + the well-known password yields a working short-TTL token", async () => {
    const shop = makeShop();
    const response = await shop(
      "/api/legacy-login",
      postJson({ email: "mum@example.com", password: "correct-horse" }),
    );
    expect(response.status).toBe(200);
    const { accessToken, expiresInSeconds } = await response.json<{
      accessToken: string;
      expiresInSeconds: number;
    }>();
    expect(expiresInSeconds).toBe(DEFAULT_ACCESS_TTL_SECONDS);
    const me = await shop("/api/me", bearer(accessToken));
    expect(await me.json()).toMatchObject({ sub: "mum@example.com", clientId: "legacy-login" });
  });

  test("rejects wrong passwords and missing emails", async () => {
    const shop = makeShop();
    expect(
      (await shop("/api/legacy-login", postJson({ email: "a@b.c", password: "nope" }))).status,
    ).toBe(401);
    expect((await shop("/api/legacy-login", postJson({ password: "correct-horse" }))).status).toBe(
      401,
    );
  });

  test("backdoor expire-tokens kills legacy tokens too", async () => {
    const shop = makeShop();
    const { accessToken } = await (
      await shop("/api/legacy-login", postJson({ email: "a@b.c", password: "correct-horse" }))
    ).json<{ accessToken: string }>();
    await shop("/__backdoor/expire-tokens", { method: "POST" });
    expect((await shop("/api/me", bearer(accessToken))).status).toBe(401);
  });
});

describe("token endpoint outage (backdoor-scheduled)", () => {
  test("fails the next N token calls, then recovers", async () => {
    const shop = makeShop();
    expect((await shop("/__backdoor/fail-token-endpoint", postJson({ times: 2 }))).status).toBe(
      200,
    );
    const attempt = () =>
      exchange(shop, {
        clientId: DEFAULT_CLIENT_ID,
        clientSecret: DEFAULT_CLIENT_SECRET,
        body: { grant_type: "refresh_token", refresh_token: "irrelevant" },
      });
    expect((await attempt()).status).toBe(500);
    expect((await attempt()).status).toBe(500);
    // Third call reaches the real endpoint (and fails normally on the junk token).
    expect((await attempt()).status).toBe(400);
    expect((await backdoorState(shop)).tokenEndpointFailuresRemaining).toBe(0);
  });

  test("rejects a non-integer times", async () => {
    const shop = makeShop();
    expect(
      (await shop("/__backdoor/fail-token-endpoint", postJson({ times: "many" }))).status,
    ).toBe(400);
  });
});

describe("webhooks", () => {
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/hook`,
      received,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const hexHmac = (secret: string, body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  test("fires HMAC-signed webhooks the receiver can verify", async () => {
    const shop = makeShop();
    const receiver = await startReceiver();
    try {
      const fire = await shop(
        "/__backdoor/webhooks/fire",
        postJson({ url: receiver.url, event: { event: "pet.adopted", petId: "pet-1" } }),
      );
      expect(fire.status).toBe(200);
      const result = await fire.json<{ status: number; signature: string }>();
      expect(result.status).toBe(200);

      const delivery = receiver.received[0];
      expect(JSON.parse(delivery.body)).toEqual({ event: "pet.adopted", petId: "pet-1" });
      const { webhookSigningSecret } = await backdoorState(shop);
      expect(delivery.signature).toBe(hexHmac(webhookSigningSecret, delivery.body));
      expect(result.signature).toBe(delivery.signature);
    } finally {
      await receiver.close();
    }
  });

  test("badSignature deliveries fail verification; rotation switches the key", async () => {
    const shop = makeShop();
    const receiver = await startReceiver();
    try {
      await shop("/__backdoor/webhooks/fire", postJson({ url: receiver.url, badSignature: true }));
      const oldSecret = (await backdoorState(shop)).webhookSigningSecret;
      expect(receiver.received[0].signature).not.toBe(
        hexHmac(oldSecret, receiver.received[0].body),
      );

      const rotated = await (
        await shop("/__backdoor/rotate-signing-secret", { method: "POST" })
      ).json<{ webhookSigningSecret: string }>();
      expect(rotated.webhookSigningSecret).not.toBe(oldSecret);
      await shop("/__backdoor/webhooks/fire", postJson({ url: receiver.url }));
      expect(receiver.received[1].signature).toBe(
        hexHmac(rotated.webhookSigningSecret, receiver.received[1].body),
      );
    } finally {
      await receiver.close();
    }
  });

  test("reports unreachable targets instead of throwing, and rejects bad URLs", async () => {
    const shop = makeShop();
    const dead = await (
      await shop("/__backdoor/webhooks/fire", postJson({ url: "http://127.0.0.1:1/hook" }))
    ).json<{ status: number }>();
    expect(dead.status).toBe(0);
    expect((await shop("/__backdoor/webhooks/fire", postJson({ url: "not-a-url" }))).status).toBe(
      400,
    );
  });
});

describe("gateway routes", () => {
  test("GET / documents all three websocket gateways", async () => {
    const shop = makeShop();
    const index = await (await shop("/")).text();
    expect(index).toContain("/gateway");
    expect(index).toContain("/gateway-header");
    expect(index).toContain("/gateway-subprotocol");
  });

  // The socket path (WebSocketPair + 101) only exists in workerd, so the Node
  // unit lane can only assert the 426 guard; the live e2e drives the sockets.
  test.each(["/gateway", "/gateway-header", "/gateway-subprotocol"])(
    "GET %s without an Upgrade header is 426, not a socket",
    async (path) => {
      const shop = makeShop();
      const response = await shop(path);
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({ error: "upgrade_required" });
    },
  );
});

describe("backdoor lock", () => {
  test("requires x-petshop-backdoor when PETSHOP_BACKDOOR_SECRET is set", async () => {
    const shop = makeShop("hunter2");
    expect((await shop("/__backdoor/state")).status).toBe(403);
    expect(
      (await shop("/__backdoor/state", { headers: { "x-petshop-backdoor": "hunter2" } })).status,
    ).toBe(200);
    // The rest of the shop stays open.
    expect((await shop("/")).status).toBe(200);
  });
});

describe("mcp oauth (RFC 9728 / 8414 / 7591 + PKCE)", () => {
  const ORIGIN = "https://petshop.example";

  test("unauthorized /mcp answers 401 pointing at protected-resource metadata", async () => {
    const shop = makeShop();
    const response = await shop("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("discovery documents name the resource, auth server, and endpoints", async () => {
    const shop = makeShop();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      expect(await (await shop(path)).json()).toEqual({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
      });
    }
    const as = await (await shop("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    });
  });

  test("dynamic registration mints a confidential client", async () => {
    const shop = makeShop();
    const response = await shop("/oauth/register", {
      ...postJson({ redirect_uris: [REDIRECT_URI], client_name: "iterate" }),
    });
    expect(response.status).toBe(201);
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

  test("register with no absolute redirect_uri is rejected", async () => {
    const shop = makeShop();
    const response = await shop("/oauth/register", { ...postJson({ redirect_uris: [] }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("full PKCE code flow: register → authorize(challenge) → token(verifier) → /mcp", async () => {
    const shop = makeShop();
    const client = (await (
      await shop("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
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
    expect(good.status).toBe(200);
    const tokens = (await good.json()) as { access_token: string };
    const mcp = await shop("/mcp", {
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
    expect(mcp.status).toBe(200);
  });

  test("a code minted with a challenge is not redeemable without the verifier", async () => {
    const shop = makeShop();
    const client = (await (
      await shop("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
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
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("public client (token_endpoint_auth_method none): no secret, client_id + PKCE at token", async () => {
    const shop = makeShop();
    const registration = (await (
      await shop("/oauth/register", {
        ...postJson({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      })
    ).json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
    // A public client gets no secret back.
    expect(registration.client_secret).toBeUndefined();
    expect(registration.token_endpoint_auth_method).toBe("none");

    const verifier = "verifier-" + "p".repeat(50);
    const location = await approve(shop, {
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: await pkceS256(verifier),
    });
    // No Basic auth — the client identifies itself with client_id in the body.
    const token = await shop("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: location.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string; refresh_token: string };
    expect((await shop("/api/me", bearer(tokens.access_token))).status).toBe(200);

    // Public-client refresh: client_id in the body, still no Basic auth.
    const refreshed = await shop("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
  });

  test("a public client with no PKCE verifier is rejected", async () => {
    const shop = makeShop();
    const registration = (await (
      await shop("/oauth/register", {
        ...postJson({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      })
    ).json()) as { client_id: string };
    // No code_challenge at authorize → the public code has no PKCE binding.
    const location = await approve(shop, {
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
    });
    const token = await shop("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: location.searchParams.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("a dynamically-registered client is pinned to its redirect URIs", async () => {
    const shop = makeShop();
    const client = (await (
      await shop("/oauth/register", { ...postJson({ redirect_uris: [REDIRECT_URI] }) })
    ).json()) as { client_id: string };
    // An unregistered redirect_uri is refused (no open redirect).
    const rejected = await shop(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/steal")}&approve=1`,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_request" });
  });
});
