import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { appSession } from "../src/client/app-auth.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { directory } from "../src/directory.ts";
import { cleanGrantActivity } from "../src/oauth.ts";
import type { Env } from "../src/control-plane.ts";
import schema from "../src/control-plane.sql?raw";

const bindings = env as unknown as Env;
const origin = "https://control.test";
const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

beforeAll(async () => {
  await bindings.DB.batch(
    schema
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => bindings.DB.prepare(s)),
  );
});
afterEach(() => vi.restoreAllMocks());

async function googleLogin(overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "google-test",
    alg: "RS256",
    use: "sig",
  };
  const metadata = {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
  let tokenResponse: object | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://accounts.google.com/.well-known/openid-configuration")
      return Response.json(metadata);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });
    if (url.href === "https://oauth2.googleapis.com/token" && tokenResponse)
      return Response.json(tokenResponse);
    if (url.origin === origin) return SELF.fetch(new Request(input, init));
    throw new Error(`Unexpected Google fixture fetch: ${url}`);
  });
  const begin = await SELF.fetch(`${origin}/.auth/identity?next=%2Fauthorize%3Fclient%3Dtest`, {
    redirect: "manual",
  });
  expect(begin.status).toBe(302);
  const authorization = new URL(begin.headers.get("location")!);
  const cookie = begin.headers.get("set-cookie")!.split(";")[0]!;
  const claims = {
    iss: "https://accounts.google.com",
    sub: "1234567890",
    aud: "google-test-client",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: authorization.searchParams.get("nonce"),
    email: "verified@example.com",
    email_verified: true,
    ...overrides,
  };
  const signingInput = `${encode({ alg: "RS256", kid: "google-test" })}.${encode(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  if (invalidSignature) signature[0] ^= 1;
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  tokenResponse = {
    access_token: "upstream-google-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${signingInput}.${encodedSignature}`,
  };
  return SELF.fetch(
    `${origin}/.auth/identity/callback?code=google-code&state=${authorization.searchParams.get("state")}`,
    {
      headers: { cookie },
      redirect: "manual",
    },
  );
}

test("Google proves issuer identity; upstream credentials never become app tokens", async () => {
  const response = await googleLogin();
  expect(response.status, await response.clone().text()).toBe(303);
  expect(response.headers.get("location")).toBe("/authorize?client=test");
  const cookies = response.headers.getSetCookie();
  expect(cookies.join()).not.toContain("upstream-google-access-token");
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("__Host-itx-session="))!;
  const ctx = createExecutionContext();
  const session = appSession(
    bindings.BROWSER_SESSION,
    new Request(origin, { headers: { cookie: sessionCookie } }),
  )!;
  const auth = await authorizationForToken(bindings, ctx, (await session.bearer())!);
  await waitOnExecutionContext(ctx);
  expect(auth?.principal).toEqual({
    actor: "user_google_1234567890",
    email: "verified@example.com",
  });
  expect(auth?.grant?.kind).toBe("issuer");
  const api = await SELF.fetch(`${origin}/api`, {
    method: "POST",
    body: "",
    headers: { cookie: sessionCookie, origin },
  });
  expect(api.status).toBe(200);
  expect(cookies).toHaveLength(2); // Cleared Google flow plus the sole app-session cookie.
});

test("Google subject keeps the same principal when its verified email changes", async () => {
  const response = await googleLogin({ email: "changed@example.com" });
  expect(response.status).toBe(303);
  const row = await bindings.DB.prepare("SELECT id, email FROM users WHERE id = ?")
    .bind("user_google_1234567890")
    .first();
  expect(row).toEqual({ id: "user_google_1234567890", email: "changed@example.com" });
});

test("wrong nonce, signature and unverified email cannot establish issuer identity", async () => {
  for (const [claims, badSignature, status] of [
    [{ nonce: "foreign-browser" }, false, 400],
    [{}, true, 400],
    [{ email_verified: false }, false, 403],
  ] as const) {
    const response = await googleLogin(claims, badSignature);
    expect(response.status).toBe(status);
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-itx-session=")),
    ).toBe(false);
  }
});

test("deployed email fixture requires the administrator credential", async () => {
  const response = await SELF.fetch(`${origin}/login`, {
    method: "POST",
    body: new URLSearchParams({ email: "unverified@example.com" }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.has("set-cookie")).toBe(false);
  expect((await SELF.fetch("https://unknown.projects.test/.auth/identity/callback")).status).toBe(
    421,
  );
});

test("activity cleanup retains recent authority and unresolved provider cleanup", async () => {
  const old = Date.now() - 32 * 24 * 3600_000;
  for (const [id, used, revoked, pending] of [
    ["old-use", old, null, 0],
    ["old-revoke", null, old, 0],
    ["current", Date.now(), null, 0],
    ["pending", old, old, 1],
  ] as const)
    await bindings.DB.prepare(
      "INSERT INTO oauth_activity (user_id, grant_id, last_used_at, revoked_at, cleanup_pending) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("cleanup-test", id, used, revoked, pending)
      .run();
  await cleanGrantActivity(bindings);
  const rows = await bindings.DB.prepare(
    "SELECT grant_id FROM oauth_activity WHERE user_id = ? ORDER BY grant_id",
  )
    .bind("cleanup-test")
    .all();
  expect(rows.results).toEqual([{ grant_id: "current" }, { grant_id: "pending" }]);
});

test("verified Google identity adopts a fixture account once and cannot take another linked identity", async () => {
  const registry = directory(bindings.DB);
  const fixture = await registry.upsertUser("fixture@identity.test");
  const linked = await registry.upsertGoogleUser("fixture-subject", fixture.email);
  expect(linked.id).toBe(fixture.id);
  await expect(registry.upsertGoogleUser("different-subject", fixture.email)).rejects.toThrow(
    /another linked account/,
  );
  const changed = await registry.upsertGoogleUser("fixture-subject", "new@identity.test");
  expect(changed.id).toBe(fixture.id);
  const oldEmail = await registry.upsertUser("fixture@identity.test");
  expect(oldEmail.id).not.toBe(fixture.id);
  expect(await registry.upsertUser(changed.email)).toEqual(changed);
});
