/**
 * Unit tests for the GitHub-App installation stand-in,
 * run in plain Node like worker.test.ts/gateway.test.ts. The whole loop is
 * hermetic: generate an RSA keypair in-test, register ONLY the public key with
 * petshop's App registry, sign an App JWT with the private key exactly as the OS
 * side's secrets `sign()` compute method does (RS256 over `header.payload`,
 * base64url), exchange it for an installation token, and drive the bearer API
 * with it. This proves petshop verifies REAL signatures and never needs — never
 * even sees — the private key.
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { expect, test, vi } from "vitest";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";
import { DEFAULT_APP_ID, DEFAULT_INSTALLATION_ID } from "./state.ts";
import { makeShop, type Shop } from "./test/shop.ts";

type AppKeys = Awaited<ReturnType<typeof generateAppKeys>>;

let sharedKeysPromise: Promise<{ app: AppKeys; attacker: AppKeys }> | undefined;

// Whichever row runs first pays for the two RSA keypairs (`sharedKeys()`), which dominate this
// file; that one-time cost had a 30 s `beforeAll` budget and keeps it as this file's row budget.
vi.setConfig({ testTimeout: 30_000 });

test("installation-token minting: a signed App JWT exchanges for an installation token that works on the API", async () => {
  const shop = makeShop();
  const { privateKey, publicKeyPem } = (await sharedKeys()).app;

  // Register ONLY the public key against the seeded installation.
  const registered = await shop.call("/__backdoor/apps", postJson({ publicKeyPem }));
  expect(registered).toMatchObject({ status: 201 });
  expect(await registered.json()).toMatchObject({
    appId: DEFAULT_APP_ID,
    installationId: DEFAULT_INSTALLATION_ID,
    publicKeyPem,
  });

  const jwt = await signAppJwt(privateKey, appJwtClaims(DEFAULT_APP_ID));
  const minted = await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, jwt);
  expect(minted).toMatchObject({ status: 201 });
  const { token, expires_at } = await minted.json<{ token: string; expires_at: string }>();
  expect(token).toBeTruthy();
  expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());

  // The installation token names which installation it acts as, on /api/me…
  const me = await shop.call("/api/me", bearer(token));
  expect(me).toMatchObject({ status: 200 });
  expect(await me.json()).toMatchObject({
    installationId: DEFAULT_INSTALLATION_ID,
    appId: DEFAULT_APP_ID,
  });

  // …and is a first-class bearer on the rest of the API.
  const pets = await shop.call("/api/pets", bearer(token));
  expect(pets).toMatchObject({ status: 200 });
  expect(await pets.json()).toMatchObject({ owner: `installation:${DEFAULT_INSTALLATION_ID}` });
});

test("installation-token minting: registering a distinct app id + installation id mints a token naming them", async () => {
  const shop = makeShop();
  const { privateKey, publicKeyPem } = (await sharedKeys()).app;
  const created = await shop.call(
    "/__backdoor/apps",
    postJson({ appId: "app-42", installationId: "install-42", publicKeyPem }),
  );
  expect(created).toMatchObject({ status: 201 });

  const jwt = await signAppJwt(privateKey, appJwtClaims("app-42"));
  const minted = await mintInstallationToken(shop, "install-42", jwt);
  expect(minted).toMatchObject({ status: 201 });
  const { token } = await minted.json<{ token: string }>();
  expect(await (await shop.call("/api/me", bearer(token))).json()).toMatchObject({
    installationId: "install-42",
    appId: "app-42",
  });
});

test("installation-token minting: a JWT signed by a different key than the registered one is rejected 401", async () => {
  const shop = makeShop();
  const { publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem }));

  const jwt = await signAppJwt(
    (await sharedKeys()).attacker.privateKey,
    appJwtClaims(DEFAULT_APP_ID),
  );
  const response = await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, jwt);
  expect(response).toMatchObject({ status: 401 });
  expect(await response.json()).toMatchObject({
    error: "invalid_jwt",
    error_description: "bad_signature",
  });
});

test("installation-token minting: an expired App JWT is rejected 401", async () => {
  const shop = makeShop();
  const { privateKey, publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem }));

  const jwt = await signAppJwt(
    privateKey,
    appJwtClaims(DEFAULT_APP_ID, { exp: Math.floor(Date.now() / 1000) - 10 }),
  );
  const response = await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, jwt);
  expect(response).toMatchObject({ status: 401 });
  expect(await response.json()).toMatchObject({
    error: "invalid_jwt",
    error_description: "expired",
  });
});

test("installation-token minting: a JWT whose iss is not the app id is rejected 401", async () => {
  const shop = makeShop();
  const { privateKey, publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem }));

  const jwt = await signAppJwt(privateKey, appJwtClaims(DEFAULT_APP_ID, { iss: "some-other-app" }));
  const response = await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, jwt);
  expect(response).toMatchObject({ status: 401 });
  expect(await response.json()).toMatchObject({
    error: "invalid_jwt",
    error_description: "issuer_mismatch",
  });
});

test("installation-token minting: the seeded installation is keyless until a key is registered; unknown ids 401", async () => {
  const shop = makeShop();
  const { privateKey } = (await sharedKeys()).app;
  const jwt = await signAppJwt(privateKey, appJwtClaims(DEFAULT_APP_ID));

  // No key registered yet → keyless installation → 401.
  const keyless = await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, jwt);
  expect(keyless).toMatchObject({ status: 401 });
  expect(await keyless.json()).toMatchObject({ error: "invalid_installation" });

  // An unknown installation id is likewise a 401.
  expect(await mintInstallationToken(shop, "no-such-installation", jwt)).toMatchObject({
    status: 401,
  });
});

test("installation-token minting: a missing or malformed Authorization JWT is rejected 401", async () => {
  const shop = makeShop();
  const { publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem }));

  const noAuth = await shop.call(`/app/installations/${DEFAULT_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
  });
  expect(noAuth).toMatchObject({ status: 401 });
  expect(await mintInstallationToken(shop, DEFAULT_INSTALLATION_ID, "not.a.jwt")).toMatchObject({
    status: 401,
  });
});

test("installation-token minting: registering without a public key is a 400", async () => {
  const shop = makeShop();
  expect(await shop.call("/__backdoor/apps", postJson({}))).toMatchObject({ status: 400 });
});

test("installation webhooks: echo mode returns a body signed with the app's webhookSecret (OS verifies this)", async () => {
  const shop = makeShop();
  const { publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem, webhookSecret: "wh-secret-123" }));

  const fired = await (
    await shop.call(
      "/__backdoor/apps/fire-webhook",
      postJson({ event: { event: "installation_repositories", action: "added" } }),
    )
  ).json<{ installationId: string; signature: string; payload: string }>();
  expect(fired).toMatchObject({ installationId: DEFAULT_INSTALLATION_ID });
  expect(JSON.parse(fired.payload)).toEqual({
    event: "installation_repositories",
    action: "added",
  });
  // The OS side verifies exactly this: sha256=<hmac-sha256(webhookSecret, rawBody)>.
  expect(fired).toMatchObject({ signature: hexHmac("wh-secret-123", fired.payload) });
});

test("installation webhooks: badSignature deliveries do not verify against the webhookSecret", async () => {
  const shop = makeShop();
  const { publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem, webhookSecret: "wh-secret-123" }));

  const fired = await (
    await shop.call("/__backdoor/apps/fire-webhook", postJson({ badSignature: true }))
  ).json<{ signature: string; payload: string }>();
  expect(fired).not.toMatchObject({ signature: hexHmac("wh-secret-123", fired.payload) });
});

test("installation webhooks: deliver mode POSTs the x-hub-signature-256 header (GitHub shape) a receiver verifies", async () => {
  const shop = makeShop();
  const { publicKeyPem } = (await sharedKeys()).app;
  await shop.call("/__backdoor/apps", postJson({ publicKeyPem, webhookSecret: "wh-secret-123" }));
  const receiver = await startReceiver();
  try {
    // This test is about the SIGNATURE SHAPE, not TCP reliability: a
    // loopback fetch can transiently fail in the CI sandbox (status 0), so
    // status 0 gets a couple of retries — a genuinely broken delivery still
    // fails, now with the carried error instead of a bare 0.
    let fired: { status: number; signature: string; error?: string };
    for (let attempt = 1; ; attempt += 1) {
      fired = await (
        await shop.call(
          "/__backdoor/apps/fire-webhook",
          postJson({ url: receiver.url, event: { event: "ping" } }),
        )
      ).json<{ status: number; signature: string; error?: string }>();
      if (fired.status !== 0 || attempt >= 3) break;
      console.warn(`webhook delivery attempt ${attempt} failed: ${fired.error}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(fired.error).toBeUndefined();
    expect(fired).toMatchObject({ status: 200 });

    const delivery = receiver.received.at(-1)!;
    expect(delivery).toMatchObject({ signature: hexHmac("wh-secret-123", delivery.body) });
    expect(delivery).toMatchObject({ signature: fired.signature });
  } finally {
    await receiver.close();
  }
});

test("installation webhooks: firing at an unknown installation id is a 400", async () => {
  const shop = makeShop();
  const response = await shop.call(
    "/__backdoor/apps/fire-webhook",
    postJson({ installationId: "no-such-installation" }),
  );
  expect(response).toMatchObject({ status: 400 });
});

const postJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

/** POST the installation-token endpoint with an App JWT in the Bearer header. */
const mintInstallationToken = (shop: Shop, installationId: string, jwt: string) =>
  shop.call(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
  });

/** base64url (no padding) of raw bytes — the JWT segment / `sign()` encoding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate an RSA keypair and export its public key to SPKI PEM — what a GitHub
 * App's owner hands the provider; the private key stays home (here: in-test). */
async function generateAppKeys(): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  let raw = "";
  for (const byte of spki) raw += String.fromCharCode(byte);
  return {
    privateKey: keyPair.privateKey,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${btoa(raw)}\n-----END PUBLIC KEY-----`,
  };
}

/** RSA generation dominates this suite and every test only reads the keys, so the file generates
 * both keypairs once, on first use. */
function sharedKeys(): Promise<{ app: AppKeys; attacker: AppKeys }> {
  sharedKeysPromise ||= Promise.all([generateAppKeys(), generateAppKeys()]).then(
    ([app, attacker]) => ({ app, attacker }),
  );
  return sharedKeysPromise;
}

/**
 * Sign an App JWT the SAME way the OS side's secrets `sign()` does: RS256 over
 * the ASCII `header.payload`, signature base64url, joined `header.payload.sig`.
 * This is the exact byte shape petshop's `verifyAppJwt` splits and verifies.
 */
async function signAppJwt(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      encoder.encode(signingInput) as BufferSource,
    ),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

/** GitHub App JWT claims: issuer = the app id, short-lived (10 min max). */
function appJwtClaims(
  appId: string,
  overrides: { iss?: string; exp?: number } = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: overrides.iss || appId, iat: now - 30, exp: overrides.exp ?? now + 540 };
}

const hexHmac = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A local HTTP sink capturing the GitHub-shaped signature header + body. */
async function startReceiver() {
  const received: { body: string; signature: string | null }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        body,
        signature: request.headers["x-hub-signature-256"]?.toString() ?? null,
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
