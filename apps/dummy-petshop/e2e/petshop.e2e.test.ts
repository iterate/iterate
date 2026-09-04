/**
 * Live e2e for a DEPLOYED dummy-petshop:
 *
 *   PETSHOP_BASE_URL=https://dummy-petshop.iterate-preview-3.com pnpm test:e2e
 *
 * Drives the same golden paths as the unit suite (src/worker.test.ts), but
 * over the network against the real worker + Durable Object: mint a client
 * through the backdoor, run the consent-free authorize lane, exchange the
 * code with Basic auth, hit the API, prove REAL access-token expiry with a
 * 2-second TTL, refresh, legacy-login, and verify webhook signing via the
 * echoed payload+signature.
 *
 * Every mutable operation scopes to a freshly minted client, including
 * fail-token-endpoint, so concurrent suites cannot consume each other's
 * injected failure.
 */
import { createHmac } from "node:crypto";
import { mergeCloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
import { describe, expect, test } from "vitest";
import WebSocket from "ws";

function requirePetshopBaseUrl(): string {
  const value = process.env.PETSHOP_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "PETSHOP_BASE_URL is required for dummy-petshop e2e tests. Deploy one " +
        "(pnpm run deploy --env preview_N) or run `pnpm dev`, then re-run with " +
        "PETSHOP_BASE_URL=https://… .",
    );
  }
  return value.replace(/\/+$/, "");
}

const baseUrl = requirePetshopBaseUrl();
const shop = (path: string, init?: RequestInit) =>
  fetch(new URL(path, baseUrl), {
    redirect: "manual",
    ...init,
    headers: mergeCloudflareWorkerVersionOverrideHeaders(init?.headers, process.env),
  });
const postJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

const REDIRECT_URI = "https://project.example/integrations/petshop/callback";

/** What POST /__backdoor/clients returns. */
type MintedClient = { clientId: string; clientSecret: string };

/** RFC 6749 token-endpoint success body (the fields these tests read). */
type TokenBody = { access_token: string; refresh_token: string; expires_in: number };

/** What /__backdoor/webhooks/fire echoes back for signature verification. */
type FiredWebhook = { status: number; signature: string; payload: string };

async function mintClient(accessTokenTtlSeconds?: number): Promise<MintedClient> {
  const response = await shop(
    "/__backdoor/clients",
    postJson(accessTokenTtlSeconds ? { accessTokenTtlSeconds } : {}),
  );
  expect(response.status).toBe(201);
  return response.json();
}

/** The consent-free authorize lane (&approve=1) → sealed code from the redirect. */
async function authorizeCode(clientId: string, user: string): Promise<string> {
  const response = await shop(
    `/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&approve=1&user=${encodeURIComponent(user)}`,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe("s");
  return location.searchParams.get("code") ?? "";
}

async function exchange(
  client: { clientId: string; clientSecret: string },
  body: Record<string, string>,
): Promise<Response> {
  return shop("/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` },
    body: new URLSearchParams(body),
  });
}

describe("deployed dummy-petshop", () => {
  test("serves its index and consent page", async () => {
    const index = await shop("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("/oauth/token");

    const { clientId } = await mintClient();
    const consent = await shop(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Approve");
  });

  test("full OAuth dance: authorize → Basic-auth code exchange → API → refresh", async () => {
    const client = await mintClient();
    const code = await authorizeCode(client.clientId, "E2E Human");

    const tokens = await (
      await exchange(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      })
    ).json<TokenBody>();
    expect(tokens.access_token).toBeTruthy();

    const me = await shop("/api/me", bearer(tokens.access_token));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ sub: "E2E Human", clientId: client.clientId });

    const refreshed = await exchange(client, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
  });

  test("access tokens really expire (2s TTL) and refresh revives access", async () => {
    const client = await mintClient(2);
    const code = await authorizeCode(client.clientId, "Short Lived");
    const tokens = await (
      await exchange(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      })
    ).json<TokenBody>();
    expect(tokens.expires_in).toBe(2);
    expect((await shop("/api/me", bearer(tokens.access_token))).status).toBe(200);

    // Outlive the 2s TTL for real.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await shop("/api/me", bearer(tokens.access_token))).status).toBe(401);

    const next = await (
      await exchange(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    ).json<TokenBody>();
    expect((await shop("/api/me", bearer(next.access_token))).status).toBe(200);
  });

  test("legacy login mints a working token; wrong password is rejected", async () => {
    const ok = await shop(
      "/api/legacy-login",
      postJson({ email: "mum@example.com", password: "correct-horse" }),
    );
    expect(ok.status).toBe(200);
    const { accessToken } = await ok.json<{ accessToken: string }>();
    expect((await shop("/api/me", bearer(accessToken))).status).toBe(200);

    const bad = await shop(
      "/api/legacy-login",
      postJson({ email: "mum@example.com", password: "wrong" }),
    );
    expect(bad.status).toBe(401);
  });

  test("webhook firing signs with the current secret; badSignature does not", async () => {
    // The echoed payload+signature is what we verify — no receiver needed
    // (real delivery against a live HTTP sink is covered by the unit suite).
    // The target is the shop's own hostname purely so the URL is real; a
    // worker cannot fetch its own zone route, so the delivery status is
    // whatever the edge says (522) and deliberately not asserted.
    const target = `${baseUrl}/webhook-target`;
    const state = await (await shop("/__backdoor/state")).json<{ webhookSigningSecret: string }>();
    const good = await (
      await shop("/__backdoor/webhooks/fire", postJson({ url: target }))
    ).json<FiredWebhook>();
    const expected = `sha256=${createHmac("sha256", state.webhookSigningSecret).update(good.payload).digest("hex")}`;
    expect(good.signature).toBe(expected);

    const bad = await (
      await shop("/__backdoor/webhooks/fire", postJson({ url: target, badSignature: true }))
    ).json<FiredWebhook>();
    const badExpected = `sha256=${createHmac("sha256", state.webhookSigningSecret).update(bad.payload).digest("hex")}`;
    expect(bad.signature).not.toBe(badExpected);
  });

  test("fail-token-endpoint fails exactly the next N calls", async () => {
    const client = await mintClient();
    expect(
      (
        await shop(
          "/__backdoor/fail-token-endpoint",
          postJson({ clientId: client.clientId, times: 1 }),
        )
      ).status,
    ).toBe(200);
    const first = await exchange(client, { grant_type: "refresh_token", refresh_token: "junk" });
    expect(first.status).toBe(500);
    const second = await exchange(client, { grant_type: "refresh_token", refresh_token: "junk" });
    expect(second.status).toBe(400); // the real endpoint again, failing on the junk token
  });
});

/** The pet shop's capnweb API as a client sees it (src/capnweb.ts's PetshopCapnwebApi). */
type PetshopCapnwebApi = {
  listPets(): Promise<{ owner: string; pets: { id: string; name: string; species: string }[] }>;
  getPet(id: string): Promise<{ id: string; name: string; species: string }>;
  createPet(input: {
    name: string;
    species: string;
  }): Promise<{ id: string; name: string; species: string }>;
};

/** A legacy-login bearer — the cheapest live token the shop mints (any email, the fixture password). */
async function legacyLoginToken(email: string): Promise<string> {
  const response = await shop("/api/legacy-login", postJson({ email, password: "correct-horse" }));
  expect(response.status).toBe(200);
  return (await response.json<{ accessToken: string }>()).accessToken;
}

describe("capnweb door (/capnweb)", () => {
  test("HTTP batch: the bearer in the Authorization header opens the pets API; a whole chain rides one POST", async () => {
    const token = await legacyLoginToken("capnweb-batch@example.com");
    // capnweb's batch client POSTs the Request it is given (headers kept), through Node's fetch.
    const api = newHttpBatchRpcSession(
      new Request(`${baseUrl}/capnweb`, {
        headers: mergeCloudflareWorkerVersionOverrideHeaders(bearer(token).headers, process.env),
      }),
    ) as unknown as PetshopCapnwebApi;
    const [listed, created, fetched] = await Promise.all([
      api.listPets(),
      api.createPet({ name: "Rex", species: "terrier" }),
      api.getPet("pet-1"),
    ]);
    expect(listed.owner).toBe("capnweb-batch@example.com");
    expect(listed.pets.map((pet) => pet.name)).toContain("Biscuit");
    expect(created).toMatchObject({ name: "Rex", species: "terrier" });
    expect(fetched).toMatchObject({ id: "pet-1", name: "Biscuit", species: "beagle" });
  });

  test("HTTP batch: no bearer is a 401 the client sees", async () => {
    const api = newHttpBatchRpcSession(
      new Request(`${baseUrl}/capnweb`, {
        headers: mergeCloudflareWorkerVersionOverrideHeaders(undefined, process.env),
      }),
    ) as unknown as PetshopCapnwebApi;
    await expect(api.listPets()).rejects.toThrow(/401/);
  });

  test("WebSocket: the bearer rides the Authorization UPGRADE header; the session serves calls until closed", async () => {
    const token = await legacyLoginToken("capnweb-ws@example.com");
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/capnweb`, {
      headers: Object.fromEntries(
        mergeCloudflareWorkerVersionOverrideHeaders(bearer(token).headers, process.env),
      ),
    });
    const api = newWebSocketRpcSession(
      socket as unknown as globalThis.WebSocket,
    ) as unknown as PetshopCapnwebApi & Disposable;
    try {
      expect(await api.getPet("pet-2")).toMatchObject({ name: "Goldie", species: "goldfish" });
      const created = await api.createPet({ name: "Ace", species: "parrot" });
      expect(await api.getPet(created.id)).toMatchObject({ name: "Ace" });
      expect((await api.listPets()).owner).toBe("capnweb-ws@example.com");
    } finally {
      api[Symbol.dispose]();
      socket.close();
    }
  });

  test("WebSocket: no bearer — the upgrade is refused with 401", async () => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/capnweb`, {
      headers: Object.fromEntries(
        mergeCloudflareWorkerVersionOverrideHeaders(undefined, process.env),
      ),
    });
    const status = await new Promise<number | "opened">((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("open", () => resolve("opened"));
      socket.once("error", () => undefined); // the unexpected-response above is the answer
    });
    socket.close();
    expect(status).toBe(401);
  });
});
