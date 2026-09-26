// secrets.test.ts — a project secret's pure half (secrets.ts + secret-oauth.ts + secret-at-rest.ts).
// A secret IS its path `/secrets/<name>`: the placeholder substitution as a table (`resolve` is handed
// the PATH), the record normalization, the two refresh strategies against a scripted fetch, the OAuth
// first-token flow's two halves (the signed state names the secret's CONTEXT), and the material at
// rest (bound to the context, the pin and the revision).

import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import type { SecretMaterial } from "iterate/api";
import {
  beginSecretOAuth,
  completeSecretOAuth,
  isSecretOAuthState,
  normalizeSecretOAuth,
  SECRET_OAUTH_TTL_MS,
  secretOAuthCallbackPathOf,
} from "./secret-oauth.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "./secret-at-rest.ts";
import {
  assertSecretPath,
  EXCHANGE_SOURCE_MAX_CHARS,
  hmacSha256Hex,
  normalizeSecretRecord,
  originPinned,
  SecretRefused,
  refreshSecretMaterial,
  secretMaterialStringOf,
  secretPathsReferenced,
  signLendUse,
  substituteProjectSecrets,
  substituteSecretInFrame,
  verifyLendUse,
  verifySecretHmac,
} from "./secrets.ts";

// ── substitution ── `substituteProjectSecrets`, as a table: `{ url?, headers?, resolve?, becomes }`
// rows. Every `getSecret("/secrets/NAME")` placeholder in the URL (path and query — matched as the
// URL parser spelled it, `"` → %22, `{ ` → %7B%20) and the headers is replaced by its value
// (`{ field: "a.b" }` picks one string out of a JSON material — the grammar for a URL or a
// header); a placeholder with no stored secret, or a field the value has no string at, refuses,
// naming the placeholder and where it sat; substituted values are never rescanned; a NEW Request
// only when something changed (the rebuild is WS-safe — method, Upgrade and body survive it).
// `becomes` is what came back: the rebuilt Request's URL and headers (a subset), "unchanged" (the
// ORIGINAL Request — no rebuild), or `{ refused }` — the `SecretRefused` message.

// The stored secrets by PATH — what `resolve(path)` is handed (`"/secrets/a"`, never the bare name).
const secrets: Record<string, SecretMaterial> = {
  "/secrets/a": "alpha",
  "/secrets/b": "bravo",
  "/secrets/api.key_v-2": "REAL",
  "/secrets/tg": { bot: { token: "123:abc", id: 7 }, plain: "p" },
  "/secrets/obj": { accessToken: "AT", nested: { deep: "D" } },
};
const rows: {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  resolve?: (path: string) => SecretMaterial | null;
  becomes: { url?: string; headers?: Record<string, string> } | "unchanged" | { refused: string };
}[] = [
  {
    name: "two placeholders in ONE header both substitute — the splice neither swallows nor duplicates text",
    headers: { authorization: 'A=getSecret("/secrets/a") mid B=getSecret("/secrets/b") end' },
    becomes: { headers: { authorization: "A=alpha mid B=bravo end" } },
  },
  {
    name: "a header with no stored secret for its placeholder refuses, naming the placeholder and the header — never the destination",
    headers: { "x-auth": 'Bearer getSecret("/secrets/absent")' },
    becomes: {
      refused:
        'itx.fetch: no stored project secret for getSecret("/secrets/absent") in header "x-auth"',
    },
  },
  {
    name: "no placeholder anywhere returns the ORIGINAL request untouched (no needless Request rebuild)",
    headers: { authorization: "Bearer plain", "x-note": "getSecret is a word, not a call" },
    becomes: "unchanged",
  },
  {
    name: "substitution never rescans substituted VALUES (no placeholder injection through a secret)",
    headers: { "x-auth": 'getSecret("/secrets/outer")' },
    resolve: (path) => (path === "/secrets/outer" ? 'getSecret("/secrets/inner")' : "INNER-LEAKED"),
    becomes: { headers: { "x-auth": 'getSecret("/secrets/inner")' } }, // literal, not re-resolved
  },
  {
    name: "the grammar: the whole secret-name charset [a-zA-Z0-9._-], whitespace inside the parentheses, and only the `/secrets/` path",
    headers: {
      authorization: 'Bearer getSecret( "/secrets/api.key_v-2" )',
      "x-other": 'getSecret("/config/a")', // not a secret path: left as written
    },
    becomes: { headers: { authorization: "Bearer REAL", "x-other": 'getSecret("/config/a")' } },
  },
  {
    name: "`{ field }` picks one string out of a JSON-string material by its dotted path — spaced and compact",
    headers: {
      authorization: 'Bearer getSecret("/secrets/tg", { field: "bot.token" })',
      "x-compact": 'getSecret("/secrets/tg",{field:"plain"})',
    },
    becomes: { headers: { authorization: "Bearer 123:abc", "x-compact": "p" } },
  },
  {
    name: "`{ field }` picks out of an OBJECT material the same way — the multidimensional secret",
    headers: {
      authorization: 'Bearer getSecret("/secrets/obj", { field: "accessToken" })',
      "x-deep": 'getSecret("/secrets/obj", { field: "nested.deep" })',
    },
    becomes: { headers: { authorization: "Bearer AT", "x-deep": "D" } },
  },
  {
    name: "an OBJECT material with no `{ field }` refuses — a whole object is never a header",
    headers: { "x-auth": 'getSecret("/secrets/obj")' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/obj") in header "x-auth" names no field, but the secret is a JSON object — pick one with { field: "…" }',
    },
  },
  {
    name: "`{ field }` at a path the object value has no string at refuses, naming the placeholder and where it sat",
    headers: { "x-auth": 'getSecret("/secrets/tg", { field: "bot.nope" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/tg", { field: "bot.nope" }) in header "x-auth": the secret has no string at field "bot.nope"',
    },
  },
  {
    name: "`{ field }` at a non-string leaf refuses",
    headers: { "x-auth": 'getSecret("/secrets/tg", { field: "bot.id" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/tg", { field: "bot.id" }) in header "x-auth": the secret has no string at field "bot.id"',
    },
  },
  {
    name: "`{ field }` on a string value refuses",
    headers: { "x-auth": 'getSecret("/secrets/a", { field: "x" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/a", { field: "x" }) in header "x-auth" names a field, but the secret is one string, not an object',
    },
  },
  {
    // `?access_token=getSecret("/secrets/token")` is a common shape; a header-only substituter would
    // forward the credential's NAME to the destination
    name: "a secret in the URL query is substituted as ONE component — the NAME never leaves, and a value cannot add a parameter or a fragment",
    url: 'https://api.example.com/data?access_token=getSecret("/secrets/a")',
    resolve: () => "v&role=admin#frag",
    becomes: { url: "https://api.example.com/data?access_token=v%26role%3Dadmin%23frag" },
  },
  {
    name: "a secret in the URL PATH (the parser spelled it `getSecret(%22/secrets/a%22)`) is substituted too",
    url: 'https://api.example.com/token/getSecret("/secrets/a")/x',
    becomes: { url: "https://api.example.com/token/alpha/x" },
  },
  {
    name: "the `{ field }` form in the URL PATH (`%7B%20field:%20%22bot.token%22%20%7D`), `:` kept — a Telegram bot token",
    url: 'https://api.example.com/bot/getSecret("/secrets/tg", { field: "bot.token" })/send',
    becomes: { url: "https://api.example.com/bot/123:abc/send" },
  },
  {
    name: "a placeholder inside a Basic credential (a git remote's userinfo) is substituted and the credential encoded again",
    headers: {
      authorization: `Basic ${basic('x-access-token:getSecret("/secrets/obj", { field: "accessToken" })')}`,
    },
    becomes: { headers: { authorization: `Basic ${basic("x-access-token:AT")}` } },
  },
  {
    name: "a Basic credential with no placeholder in it is left as it is",
    headers: { authorization: `Basic ${basic("user:pass")}` },
    becomes: "unchanged",
  },
  {
    name: "a Basic credential naming a secret that is not stored refuses naming the header",
    headers: { authorization: `Basic ${basic('x:getSecret("/secrets/absent")')}` },
    becomes: {
      refused:
        'itx.fetch: no stored project secret for getSecret("/secrets/absent") in header "authorization"',
    },
  },
  {
    name: "a URL placeholder with no stored secret refuses naming the request URL",
    url: 'https://api.example.com/?t=getSecret("/secrets/absent")',
    becomes: {
      refused:
        'itx.fetch: no stored project secret for getSecret("/secrets/absent") in the request URL',
    },
  },
];

for (const row of rows)
  test(row.name, async () => {
    const request = new Request(row.url || "https://api.example.com/", { headers: row.headers });
    const became = await substituteProjectSecrets(
      request,
      row.resolve || ((path) => secrets[path] ?? null),
    ).then(
      (out) =>
        out === request ? "unchanged" : { url: out.url, headers: Object.fromEntries(out.headers) },
      (error: unknown) =>
        error instanceof SecretRefused ? { refused: error.message } : Promise.reject(error),
    );
    if (typeof row.becomes === "string") expect(became).toBe(row.becomes);
    else expect(became).toMatchObject(row.becomes);
  });

test("a mintable miss (no material, a missing field) is marked so the Durable Object knows a strategy may fill it; the other refusals are not", async () => {
  const miss = (resolve: (path: string) => SecretMaterial | null, header: string) =>
    substituteProjectSecrets(
      new Request("https://api.example.com/", { headers: { authorization: header } }),
      resolve,
    ).then(
      () => "substituted",
      (error: SecretRefused) => error.mintable,
    );
  expect(await miss(() => null, 'getSecret("/secrets/x")')).toBe(true);
  expect(
    await miss(() => ({ refreshToken: "r" }), 'getSecret("/secrets/x", { field: "accessToken" })'),
  ).toBe(true);
  expect(await miss(() => "plain", 'getSecret("/secrets/x", { field: "accessToken" })')).toBe(
    false,
  );
  expect(await miss(() => ({ a: 1 }), 'getSecret("/secrets/x")')).toBe(false);
});

test("secretPathsReferenced: the distinct secret PATHS a request's URL and headers name", () => {
  expect(
    secretPathsReferenced(
      new Request('https://api.example.com/?k=getSecret("/secrets/q")', {
        headers: {
          authorization: 'Bearer getSecret("/secrets/tok", { field: "accessToken" })',
          "x-b": 'getSecret("/secrets/tok")',
        },
      }),
    ),
  ).toEqual(["/secrets/q", "/secrets/tok"]);
  expect(secretPathsReferenced(new Request("https://api.example.com/"))).toEqual([]);
  expect(
    secretPathsReferenced(
      new Request("https://github.com/acme/config.git/git-upload-pack", {
        headers: { authorization: `Basic ${basic('x:getSecret("/secrets/github-acme")')}` },
      }),
    ),
  ).toEqual(["/secrets/github-acme"]);
});

test("secretPathsReferenced: a placeholder never names `/secrets/..` or `/secrets/.` — they resolve onto the owner's root, never a secret's own context; `...` is an ordinary name", () => {
  expect(
    secretPathsReferenced(
      new Request('https://api.example.com/?k=getSecret("/secrets/..")', {
        headers: { a: 'getSecret("/secrets/.")', b: 'getSecret("/secrets/...")' },
      }),
    ),
  ).toEqual(["/secrets/..."]);
});

test.each([
  { path: "/secrets/api-key", accepted: true },
  { path: "/secrets/a.b_c-1", accepted: true },
  { path: "/secrets/...", accepted: true },
  { path: "/secrets/.hidden", accepted: true },
  { path: "/secrets/..", accepted: false },
  { path: "/secrets/.", accepted: false },
  { path: "/secrets/", accepted: false },
  { path: "/secrets/a/b", accepted: false },
  { path: "/secrets/has space", accepted: false },
  { path: "secrets/api-key", accepted: false },
  { path: "/kv/api-key", accepted: false },
])("assertSecretPath($path): accepted $accepted", ({ path, accepted }) => {
  if (accepted) expect(assertSecretPath(path)).toBe(path);
  else expect(() => assertSecretPath(path)).toThrow(/a secret's path is \/secrets\/<name>/);
});

// ── the pin ── never empty: a secret goes to its origins and nowhere else.
// ── the verify operation ── `verifySecretHmac(material, { payload, signature, field? })`: one bit out.
test.each([
  {
    name: "Discord IDENTIFY: a placeholder inside a JSON string is spliced JSON-escaped",
    frame: JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")' } }),
    material: 'bot"tok\\en',
    expected: JSON.stringify({ op: 2, d: { token: 'bot"tok\\en' } }),
  },
  {
    name: "a lend's borrowed path is this secret too",
    frame: 'Bot getSecret("/secrets/lent")',
    material: "t",
    expected: "Bot t",
  },
  {
    name: "a field of an object material, in a JSON string",
    frame: JSON.stringify({ token: 'getSecret("/secrets/discord", { field: "bot.token" })' }),
    material: { bot: { token: "abc" } },
    expected: JSON.stringify({ token: "abc" }),
  },
  {
    name: "a frame with no placeholder is untouched",
    frame: "ping",
    material: "t",
    expected: "ping",
  },
])("substituteSecretInFrame: $name", ({ frame, material, expected }) => {
  expect(
    substituteSecretInFrame(
      frame,
      ["/secrets/discord", "/secrets/lent"],
      material as SecretMaterial,
    ),
  ).toBe(expected);
});

test("substituteSecretInFrame: a placeholder naming another secret, or a whole object material, is refused", () => {
  expect(() =>
    substituteSecretInFrame('getSecret("/secrets/other")', ["/secrets/discord"], "t"),
  ).toThrow(SecretRefused);
  expect(() =>
    substituteSecretInFrame('getSecret("/secrets/discord")', ["/secrets/discord"], { a: "b" }),
  ).toThrow(/names no field/);
});

test("signLendUse / verifyLendUse: the lend round-trips for its lender only, under the same key", async () => {
  const lend = { lender: "global.iterate/users/u/secrets/g", lendId: "lend_1", borrower: "prj_1" };
  const token = await signLendUse(lend, "key");
  expect(await verifyLendUse(token, "key", lend.lender)).toEqual({
    lendId: "lend_1",
    borrower: "prj_1",
  });
  expect(await verifyLendUse(token, "key", "global.iterate/users/v/secrets/g")).toBeNull();
  expect(await verifyLendUse(token, "other-key", lend.lender)).toBeNull();
  expect(await verifyLendUse("forged", "key", lend.lender)).toBeNull();
});

test("hmacSha256Hex agrees with node's HMAC over a string and over bytes", async () => {
  const oracle = (key: string, payload: string | Uint8Array) =>
    createHmac("sha256", key).update(payload).digest("hex");
  expect(await hmacSha256Hex("whsec_k", "1700000000.{}")).toBe(oracle("whsec_k", "1700000000.{}"));
  const bytes = new TextEncoder().encode("raw body ☃");
  expect(await hmacSha256Hex("k", bytes)).toBe(oracle("k", bytes));
});

test.for([
  { name: "the whole string", material: "whsec_k", field: undefined, key: "whsec_k" },
  {
    name: "an object with no field is no key",
    material: { signing: "s" },
    field: undefined,
    key: null,
  },
  {
    name: "one string field of an object",
    material: { signing: "s", n: 1 },
    field: "signing",
    key: "s",
  },
  {
    name: "a dotted field reaches into an object",
    material: { a: { b: "deep" } },
    field: "a.b",
    key: "deep",
  },
  {
    name: "a field on a JSON string is no key",
    material: JSON.stringify({ signing: "s" }),
    field: "signing",
    key: null,
  },
  {
    name: "a field on a non-JSON string is no key",
    material: "not json",
    field: "signing",
    key: null,
  },
  { name: "a non-string field is no key", material: { n: 1 }, field: "n", key: null },
  { name: "an empty string is no key", material: { signing: "" }, field: "signing", key: null },
  { name: "a missing field is no key", material: { signing: "s" }, field: "missing", key: null },
])("secretMaterialStringOf: $name", ({ material, field, key }) => {
  expect(secretMaterialStringOf(material, field)).toBe(key);
});

const hmacPayload =
  "1700000000." + JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const hmacSignature = createHmac("sha256", "whsec_k").update(hmacPayload).digest("hex");

test.for([
  { name: "the right key, payload and hex", material: "whsec_k", input: {}, verified: true },
  {
    name: "the hex in upper case, padded",
    material: "whsec_k",
    input: { signature: ` ${hmacSignature.toUpperCase()} ` },
    verified: true,
  },
  {
    name: "the payload as bytes",
    material: "whsec_k",
    input: { payload: new TextEncoder().encode(hmacPayload) },
    verified: true,
  },
  {
    name: "an object's key field, named",
    material: { signing: "whsec_k", other: 1 },
    input: { field: "signing" },
    verified: true,
  },
  {
    name: "a tampered payload",
    material: "whsec_k",
    input: { payload: hmacPayload + " " },
    verified: false,
  },
  { name: "a wrong key", material: "whsec_other", input: {}, verified: false },
  {
    name: "a wrong signature",
    material: "whsec_k",
    input: { signature: "00".repeat(32) },
    verified: false,
  },
  {
    name: "a signature with its scheme prefix", // the caller's to strip
    material: "whsec_k",
    input: { signature: "sha256=" + hmacSignature },
    verified: false,
  },
  {
    name: "a signature cut short",
    material: "whsec_k",
    input: { signature: hmacSignature.slice(0, 63) },
    verified: false,
  },
  { name: "an object with no field", material: { signing: "whsec_k" }, input: {}, verified: false },
  {
    name: "an object's non-string field",
    material: { signing: "whsec_k", other: 1 },
    input: { field: "other" },
    verified: false,
  },
])("verifySecretHmac: $name → $verified", async ({ material, input, verified }) => {
  expect(
    await verifySecretHmac(material, { payload: hmacPayload, signature: hmacSignature, ...input }),
  ).toBe(verified);
});

test.for([
  {
    name: "a pinned origin passes",
    url: "https://api.example.com/v1/x",
    pins: ["https://api.example.com"],
    pinned: true,
  },
  {
    name: "another origin does not",
    url: "https://evil.example/",
    pins: ["https://api.example.com"],
    pinned: false,
  },
  { name: "an empty pin passes nothing", url: "https://api.example.com/", pins: [], pinned: false },
])("originPinned: $name", ({ url, pins, pinned }) => {
  expect(originPinned(url, pins)).toBe(pinned);
});

// ── the record ── `normalizeSecretRecord`: what `itx.secrets.set(path, material, options)` stores.
test.for([
  {
    row: "a module exporting exchange is kept verbatim",
    source: "export async function exchange(material, fetch) { return material; }",
    outcome: {
      refresh: {
        kind: "worker",
        source: "export async function exchange(material, fetch) { return material; }",
      },
    },
  },
  {
    row: "a source with no exchange is refused",
    source: "export default {}",
    outcome: /exporting `async function exchange/,
  },
  {
    row: "a source that is not a string is refused",
    source: 42,
    outcome: /exporting `async function exchange/,
  },
  {
    row: "a source over the ceiling is refused",
    source: `export async function exchange() {} //${"x".repeat(EXCHANGE_SOURCE_MAX_CHARS)}`,
    outcome: /over the 65536-char ceiling/,
  },
])("normalizeSecretRecord, exchange code ($row)", ({ source, outcome }) => {
  const normalize = () =>
    normalizeSecretRecord(
      { email: "e", password: "p" },
      { urls: ["https://tesco.example"], refresh: { kind: "worker", source } },
    );
  if (outcome instanceof RegExp) expect(normalize).toThrow(outcome);
  else expect(normalize()).toMatchObject(outcome);
});

test("normalizeSecretRecord: the pin is required and stored as origins (deduped); a strategy is named, lies within the pin, and names its client-auth method from the registry", () => {
  expect(
    normalizeSecretRecord("v", {
      urls: ["https://api.example.com/v1/x", "https://api.example.com"],
    }),
  ).toEqual({ material: "v", urls: ["https://api.example.com"], refresh: null });
  expect(() => normalizeSecretRecord({ a: "b" }, undefined)).toThrow(/urls is required/);
  expect(() => normalizeSecretRecord("v", { urls: [] })).toThrow(/urls is required/);
  expect(() => normalizeSecretRecord("v", { urls: ["not a url"] })).toThrow();
  expect(() => normalizeSecretRecord([1], { urls: ["https://x.example"] })).toThrow(
    /string or a JSON object/,
  );
  expect(
    normalizeSecretRecord(
      { username: "u", password: "p" },
      {
        urls: ["https://www.waitrose.com"],
        refresh: { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
      },
    ),
  ).toMatchObject({
    refresh: { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
  });
  expect(
    normalizeSecretRecord(
      { clientId: "c", clientSecret: "s", refreshToken: "r" },
      {
        urls: ["https://github.com"],
        refresh: {
          kind: "oauth-refresh-token",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          clientAuth: "client_secret_post",
        },
      },
    ),
  ).toMatchObject({
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientAuth: "client_secret_post",
    },
  });
  expect(() =>
    normalizeSecretRecord("v", {
      urls: ["https://x.example"],
      refresh: { kind: "magic", tokenEndpoint: "https://x.example" },
    }),
  ).toThrow(/refresh\.kind is one of oauth-refresh-token, waitrose-session/);
  expect(() =>
    normalizeSecretRecord("v", {
      urls: ["https://api.example.com"],
      refresh: { kind: "oauth-refresh-token", tokenEndpoint: "https://elsewhere.example/token" },
    }),
  ).toThrow(/outside the pin/);
  expect(() =>
    normalizeSecretRecord("v", {
      urls: ["https://x.example"],
      refresh: {
        kind: "oauth-refresh-token",
        tokenEndpoint: "https://x.example",
        clientAuth: "body",
      },
    }),
  ).toThrow(/clientAuth is one of client_secret_basic, client_secret_post, none/);
});

// ── the strategies ── `refreshSecretMaterial(strategy, material, fetch)`: a scripted fetch records
// the exchange and answers; the NEXT material is what the Durable Object would store.
type Exchange = { url: string; headers: Record<string, string>; body: string };

test("oauth-refresh-token: a confidential client refreshes with HTTP Basic and keeps the rotated refresh token", async () => {
  const { exchanges, fetchFn } = scripted(() =>
    Response.json({ access_token: "AT2", refresh_token: "RT2", expires_in: 120 }),
  );
  const next = await refreshSecretMaterial(
    { kind: "oauth-refresh-token", tokenEndpoint: "https://auth.example/oauth/token" },
    { clientId: "c", clientSecret: "s", refreshToken: "RT1", accessToken: "AT1", extra: "kept" },
    fetchFn,
  );
  expect(next).toEqual({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "RT2",
    accessToken: "AT2",
    extra: "kept",
  });
  expect(exchanges).toEqual([
    {
      url: "https://auth.example/oauth/token",
      headers: expect.objectContaining({
        authorization: `Basic ${btoa("c:s")}`,
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: "grant_type=refresh_token&refresh_token=RT1",
    },
  ]);
});

test("oauth-refresh-token: a public client sends client_id in the body; a refusal or a bodyless answer throws without the credential", async () => {
  const pub = scripted(() => Response.json({ access_token: "AT" }));
  const next = await refreshSecretMaterial(
    { kind: "oauth-refresh-token", tokenEndpoint: "https://auth.example/token" },
    { clientId: "public-client", refreshToken: "RT" },
    pub.fetchFn,
  );
  expect(next).toEqual({ clientId: "public-client", refreshToken: "RT", accessToken: "AT" });
  expect(pub.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(pub.exchanges[0]!).toMatchObject({
    body: "grant_type=refresh_token&refresh_token=RT&client_id=public-client",
  });
  const refused = scripted(() => new Response("nope", { status: 400 }));
  await expect(
    refreshSecretMaterial(
      { kind: "oauth-refresh-token", tokenEndpoint: "https://auth.example/token" },
      { clientId: "c", refreshToken: "SECRET-RT" },
      refused.fetchFn,
    ),
  ).rejects.toThrow(/answered 400/);
  await expect(
    refreshSecretMaterial(
      { kind: "oauth-refresh-token", tokenEndpoint: "https://auth.example/token" },
      { clientId: "c" },
      refused.fetchFn,
    ),
  ).rejects.toThrow(/no "refreshToken"/);
});

test("waitrose-session: the NewSession login mints the accessToken; a failures[] answer and a 401 throw naming the fix, never the password", async () => {
  const ok = scripted(() =>
    Response.json({
      data: {
        generateSession: {
          __typename: "SetSessionPayload",
          accessToken: "SESSION",
          failures: null,
        },
      },
    }),
  );
  const next = await refreshSecretMaterial(
    { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
    { username: "mum@example.com", password: "hunter2" },
    ok.fetchFn,
  );
  expect(next).toEqual({
    username: "mum@example.com",
    password: "hunter2",
    accessToken: "SESSION",
  });
  const sent = JSON.parse(ok.exchanges[0]!.body);
  expect(sent.query).toMatch(/^mutation NewSession/);
  expect(sent).toMatchObject({
    variables: {
      input: { clientId: "ANDROID_APP", password: "hunter2", username: "mum@example.com" },
    },
  });
  expect(ok.exchanges[0]!.headers["user-agent"]).toMatch(/Waitrose/);

  const wrong = scripted(() =>
    Response.json({
      data: {
        generateSession: {
          accessToken: null,
          failures: [{ type: "AUTHENTICATION_FAILED", message: "incorrect username or password" }],
        },
      },
    }),
  );
  const failure = await refreshSecretMaterial(
    { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
    { username: "u", password: "hunter2" },
    wrong.fetchFn,
  ).then(
    () => "minted",
    (error: Error) => error.message,
  );
  expect(failure).toBe("waitrose-session: login refused (AUTHENTICATION_FAILED)");
  expect(failure).not.toContain("hunter2");
  const unauthorized = scripted(() => new Response("", { status: 401 }));
  await expect(
    refreshSecretMaterial(
      { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
      { username: "u", password: "p" },
      unauthorized.fetchFn,
    ),
  ).rejects.toThrow(/HTTP 401.*username\/password/);
});

// ── the OAuth first-token flow (secret-oauth.ts) ──
const PROVIDER = {
  authorizationEndpoint: "https://auth.example/oauth/authorize",
  tokenEndpoint: "https://auth.example/oauth/token",
};

test("normalizeSecretOAuth: the pin defaults to the token endpoint's origin, must contain it when given, and the client-auth method defaults to client_secret_basic", () => {
  expect(normalizeSecretOAuth({ ...PROVIDER, clientId: "c" })).toMatchObject({
    urls: ["https://auth.example"],
    clientAuth: "client_secret_basic",
    clientSecret: "",
    extra: {},
  });
  expect(
    normalizeSecretOAuth({
      ...PROVIDER,
      clientId: "c",
      clientSecret: "s",
      clientAuth: "client_secret_post",
      scope: "repo",
      urls: ["https://api.example/v1", "https://auth.example/x"],
      extra: { access_type: "offline" },
    }),
  ).toEqual({
    authorizationEndpoint: PROVIDER.authorizationEndpoint,
    tokenEndpoint: PROVIDER.tokenEndpoint,
    clientId: "c",
    clientSecret: "s",
    client: null,
    clientAuth: "client_secret_post",
    scope: "repo",
    urls: ["https://api.example", "https://auth.example"],
    extra: { access_type: "offline" },
    next: null,
    expectAccount: null,
  });
  expect(() =>
    normalizeSecretOAuth({ ...PROVIDER, clientId: "c", urls: ["https://api.example"] }),
  ).toThrow(/outside the pin/);
  expect(() => normalizeSecretOAuth({ ...PROVIDER, clientId: "" })).toThrow(/clientId/);
  expect(() =>
    normalizeSecretOAuth({ ...PROVIDER, authorizationEndpoint: "ftp://x", clientId: "c" }),
  ).toThrow(/http\(s\)/);
  expect(() => normalizeSecretOAuth({ ...PROVIDER, clientId: "c", clientAuth: "basic" })).toThrow(
    /clientAuth is one of/,
  );
});

test("beginSecretOAuth: the authorize URL carries the code request with PKCE S256, the signed state, the scope and the extra parameters; the pending attempt keeps the options and the verifier, never on the URL", async () => {
  const options = normalizeSecretOAuth({
    ...PROVIDER,
    clientId: "c",
    clientSecret: "sekrit-value",
    scope: "repo",
    extra: { access_type: "offline", prompt: "consent" },
  });
  const { pending, authorizationUrl } = await beginSecretOAuth(options, {
    redirectUri: "https://os.example/.secrets/oauth/callback",
    state: "signed-state",
    nonce: "n1",
    now: 1000,
  });
  const url = new URL(authorizationUrl);
  expect(url.origin + url.pathname).toBe(PROVIDER.authorizationEndpoint);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "c",
    redirect_uri: "https://os.example/.secrets/oauth/callback",
    state: "signed-state",
    code_challenge_method: "S256",
    scope: "repo",
    access_type: "offline",
    prompt: "consent",
  });
  // the challenge is the S256 of the verifier the pending attempt keeps
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pending.codeVerifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(url.searchParams.get("code_challenge")).toBe(challenge);
  expect(pending).toMatchObject({
    options,
    redirectUri: "https://os.example/.secrets/oauth/callback",
    nonce: "n1",
    until: 1000 + SECRET_OAUTH_TTL_MS,
  });
  expect(authorizationUrl).not.toContain("sekrit-value");
  expect(authorizationUrl).not.toContain(pending.codeVerifier);
});

test("completeSecretOAuth: the code exchange (HTTP Basic, PKCE verifier, redirect_uri) yields the secret's first record with the refresh strategy at the same endpoint", async () => {
  const options = normalizeSecretOAuth({ ...PROVIDER, clientId: "c", clientSecret: "s" });
  const { pending } = await beginSecretOAuth(options, {
    redirectUri: "https://os.example/.secrets/oauth/callback",
    state: "st",
    nonce: "n",
  });
  const provider = scripted(() =>
    Response.json({ access_token: "AT", refresh_token: "RT", token_type: "bearer" }),
  );
  const record = await completeSecretOAuth(pending, "the-code", provider.fetchFn);
  expect(record).toEqual({
    material: { clientId: "c", clientSecret: "s", accessToken: "AT", refreshToken: "RT" },
    urls: ["https://auth.example"],
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: PROVIDER.tokenEndpoint,
      clientAuth: "client_secret_basic",
    },
  });
  expect(provider).toMatchObject({
    exchanges: [
      {
        url: PROVIDER.tokenEndpoint,
        headers: expect.objectContaining({
          authorization: `Basic ${btoa("c:s")}`,
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: `grant_type=authorization_code&code=the-code&redirect_uri=${encodeURIComponent("https://os.example/.secrets/oauth/callback")}&code_verifier=${pending.codeVerifier}`,
      },
    ],
  });
  const refused = scripted(() => new Response("", { status: 400 }));
  await expect(completeSecretOAuth(pending, "bad", refused.fetchFn)).rejects.toThrow(
    /oauth: the token endpoint answered 400/,
  );
});

test("client_secret_post puts client_id + client_secret in the form for both grants (GitHub's shape) and sends no Basic header; none (a public client) sends client_id alone", async () => {
  const options = normalizeSecretOAuth({
    ...PROVIDER,
    clientId: "c",
    clientSecret: "s",
    clientAuth: "client_secret_post",
  });
  const { pending } = await beginSecretOAuth(options, {
    redirectUri: "https://os.example/cb",
    state: "st",
    nonce: "n",
  });
  const exchange = scripted(() => Response.json({ access_token: "AT", refresh_token: "RT" }));
  const record = await completeSecretOAuth(pending, "code", exchange.fetchFn);
  expect(exchange.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(exchange.exchanges[0]!.body).toContain("client_id=c&client_secret=s");
  expect(record).toMatchObject({
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: PROVIDER.tokenEndpoint,
      clientAuth: "client_secret_post",
    },
  });
  // the refresh strategy honours the same method
  const refresh = scripted(() => Response.json({ access_token: "AT2" }));
  await refreshSecretMaterial(record.refresh!, record.material, refresh.fetchFn);
  expect(refresh.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(refresh.exchanges[0]!).toMatchObject({
    body: "grant_type=refresh_token&refresh_token=RT&client_id=c&client_secret=s",
  });
  // a public client, whatever it declared, identifies itself with client_id alone
  const publicOptions = normalizeSecretOAuth({ ...PROVIDER, clientId: "p" });
  const { pending: publicPending } = await beginSecretOAuth(publicOptions, {
    redirectUri: "https://os.example/cb",
    state: "st",
    nonce: "n",
  });
  const publicExchange = scripted(() => Response.json({ access_token: "AT" }));
  await completeSecretOAuth(publicPending, "code", publicExchange.fetchFn);
  expect(publicExchange.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(publicExchange.exchanges[0]!.body).toContain("client_id=p");
  expect(publicExchange.exchanges[0]!.body).not.toContain("client_secret");
});

// AN INTEGRATION'S CLIENT AND `next` (secret-oauth.ts): the options passed ⇒ what the attempt keeps,
// or the refusal.
test.for([
  {
    row: "the project's own client, in the clear",
    options: { clientId: "c", clientSecret: "s" },
    becomes: { clientId: "c", clientSecret: "s", client: null, next: null },
  },
  {
    row: "iterate's Slack app",
    options: { client: { platform: "slack" } },
    becomes: { clientId: "", clientSecret: "", client: { platform: "slack" } },
  },
  {
    row: "the project's own Google client, held by the secret",
    options: { client: { project: "google" } },
    becomes: { clientId: "", client: { project: "google" } },
  },
  {
    row: "next on the Dash",
    options: { clientId: "c", next: "https://dash.example/projects/p/integrations?x=1" },
    becomes: { next: "https://dash.example/projects/p/integrations?x=1" },
  },
  {
    row: "a client beside a clientId",
    options: { clientId: "c", client: { platform: "slack" } },
    refused: /not both/,
  },
  {
    row: "a provider with no OAuth connect",
    options: { client: { platform: "github" } },
    refused: /client is/,
  },
  { row: "no client at all", options: {}, refused: /clientId \(or client\) is required/ },
  {
    row: "next on another origin",
    options: { clientId: "c", next: "https://evil.example/" },
    refused: /next is an absolute URL on https:\/\/os.example or/,
  },
  {
    row: "next relative",
    options: { clientId: "c", next: "/projects" },
    refused: /next is an absolute URL/,
  },
  {
    row: "next as javascript:",
    options: { clientId: "c", next: "javascript:alert(1)" },
    refused: /next is an absolute URL/,
  },
])("normalizeSecretOAuth, the client and next: $row", ({ options, becomes, refused }) => {
  const normalize = () =>
    normalizeSecretOAuth({ ...PROVIDER, ...options }, [
      "https://os.example",
      "https://dash.example",
    ]);
  if (refused) expect(normalize).toThrow(refused);
  else expect(normalize()).toMatchObject(becomes!);
});

test("secretOAuthCallbackPathOf: an integration's client comes back to its provider's callback, every other attempt to the one secret callback", () => {
  expect(secretOAuthCallbackPathOf({ platform: "slack" })).toBe("/api/integrations/slack/callback");
  expect(secretOAuthCallbackPathOf({ project: "google" })).toBe(
    "/api/integrations/google/callback",
  );
  expect(secretOAuthCallbackPathOf(null)).toBe("/.secrets/oauth/callback");
});

// THE RECORD AN INTEGRATION'S EXCHANGE WRITES: the client and the tokens ⇒ the record. iterate's
// client never enters the material; a project's own app stays beside its tokens.
test.for([
  {
    row: "iterate's Slack app, no refresh token",
    client: { platform: "slack" },
    tokens: { access_token: "xoxb" },
    record: { material: { accessToken: "xoxb" }, refresh: null },
  },
  {
    row: "iterate's Google client, a refresh token: the refresh names the same client",
    client: { platform: "google" },
    tokens: { access_token: "ya29", refresh_token: "1//r" },
    record: {
      material: { accessToken: "ya29", refreshToken: "1//r" },
      refresh: {
        kind: "oauth-refresh-token",
        clientAuth: "client_secret_basic",
        client: { platform: "google" },
      },
    },
  },
  {
    row: "the project's own Slack app: its credentials kept beside the token",
    client: { project: "slack" },
    tokens: { access_token: "xoxb" },
    record: {
      material: {
        clientId: "own",
        clientSecret: "own-s",
        signingSecret: "sig",
        accessToken: "xoxb",
      },
      refresh: { kind: "oauth-refresh-token", clientAuth: "client_secret_basic" },
    },
  },
])("completeSecretOAuth, an integration's record: $row", async ({ client, tokens, record }) => {
  const { pending } = await beginSecretOAuth(
    { ...normalizeSecretOAuth({ ...PROVIDER, client }), clientId: "resolved" },
    { redirectUri: "https://os.example/cb", state: "st", nonce: "n" },
  );
  const credentials =
    "platform" in client
      ? { clientId: "iterate", clientSecret: "iterate-s", kept: {} }
      : {
          clientId: "own",
          clientSecret: "own-s",
          kept: { clientId: "own", clientSecret: "own-s", signingSecret: "sig" },
        };
  const provider = scripted(() => Response.json(tokens));
  expect(await completeSecretOAuth(pending, "code", provider.fetchFn, credentials)).toEqual({
    urls: ["https://auth.example"],
    ...record,
    refresh: record.refresh && { tokenEndpoint: PROVIDER.tokenEndpoint, ...record.refresh },
  });
  expect(provider.exchanges[0]!.headers).toMatchObject({
    authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
  });
});

// A REFRESH STRATEGY NAMING WHOSE APP (normalizeSecretRecord): the strategy passed ⇒ what the record
// keeps, or the refusal.
test.for([
  {
    row: "iterate's Google client",
    options: {
      urls: ["https://oauth2.googleapis.com"],
      refresh: {
        kind: "oauth-refresh-token",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        client: { platform: "google" },
      },
    },
    keeps: { client: { platform: "google" } },
  },
  {
    row: "a provider the deployment has no app at",
    options: {
      urls: ["https://oauth2.googleapis.com"],
      refresh: {
        kind: "oauth-refresh-token",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        client: { platform: "linear" },
      },
    },
    refused: /refresh\.client is \{ platform: "slack" \| "google" \| "cloudflare" \| "github" \}/,
  },
  {
    row: "an installation of iterate's GitHub App",
    options: {
      urls: ["https://api.github.com"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com/",
        installationId: "123",
        client: { platform: "github" },
      },
    },
    keeps: {
      kind: "github-app-installation",
      apiOrigin: "https://api.github.com",
      installationId: "123",
      client: { platform: "github" },
    },
  },
  {
    row: "an installation of the project's own App",
    options: {
      urls: ["https://api.github.com"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com",
        installationId: "123",
        client: { project: "github" },
      },
    },
    keeps: { client: { project: "github" } },
  },
  {
    row: "an API outside the pin",
    options: {
      urls: ["https://github.com"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com",
        installationId: "123",
        client: { platform: "github" },
      },
    },
    refused: /refresh\.apiOrigin https:\/\/api\.github\.com is outside the pin/,
  },
  {
    row: "an installation id that would change the URL's path",
    options: {
      urls: ["https://api.github.com"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://api.github.com",
        installationId: "../app",
        client: { platform: "github" },
      },
    },
    refused: /GitHub's id/,
  },
])("normalizeSecretRecord, whose app a strategy names: $row", ({ options, keeps, refused }) => {
  const normalize = () => normalizeSecretRecord({}, options);
  if (refused) expect(normalize).toThrow(refused);
  else expect(normalize().refresh).toMatchObject(keeps!);
});

// The signed claims must carry the kind, the secret's context and every field with its type: another
// claim set signed by the same key is not a state.
const oauthState = {
  kind: "secret-oauth",
  context: "prj_x.iterate/secrets/shop",
  nonce: "x",
  exp: 1,
};

test.for([
  { name: "the claims of a state", claims: oauthState, state: true },
  { name: "another kind", claims: { ...oauthState, kind: "google-login" }, state: false },
  { name: "exp as a string", claims: { ...oauthState, exp: "1" }, state: false },
  { name: "context as a number", claims: { ...oauthState, context: 7 }, state: false },
  { name: "an array", claims: [oauthState], state: false },
  {
    name: "with a string next",
    claims: { ...oauthState, next: "https://os.example/" },
    state: true,
  },
  { name: "with a numeric next", claims: { ...oauthState, next: 1 }, state: false },
  { name: "null", claims: null, state: false },
])("isSecretOAuthState: $name → $state", ({ claims, state }) => {
  expect(isSecretOAuthState(claims)).toBe(state);
});

// ── at rest (secret-at-rest.ts) ── the material never sits in storage in the clear, and a ciphertext
// opens only at the binding it was written for.
const binding = {
  context: "prj_1.iterate/secrets/tok",
  urls: ["https://a.example", "https://b.example"],
  revision: 3,
};
const keys = { current: "key-one" };

test("encryptSecretMaterial / decryptSecretMaterial: a string and an object round-trip; the ciphertext carries neither", async () => {
  // The needles are long: a two-letter one ("AT") shows up in a random base64 IV about once in a
  // hundred runs and made this test flaky (CI, 2026-09-16).
  for (const material of [
    "hunter2",
    { accessToken: "ACCESS-TOKEN-PLAINTEXT", nested: { deep: "DEEP-PLAINTEXT" } },
  ] as const) {
    const encrypted = await encryptSecretMaterial(material, binding, keys);
    expect(encrypted).toMatchObject({ algorithm: "AES-256-GCM+SECRET-V1" });
    expect(JSON.stringify(encrypted)).not.toContain("hunter2");
    expect(JSON.stringify(encrypted)).not.toContain("ACCESS-TOKEN-PLAINTEXT");
    expect(JSON.stringify(encrypted)).not.toContain("DEEP-PLAINTEXT");
    expect(await decryptSecretMaterial(encrypted, binding, keys)).toEqual({
      material,
      rotated: false,
    });
  }
});

test("the binding: another context (another owner's, or another name's, Durable Object), another pin or another revision does not open it; the pin's spelling order does not matter", async () => {
  const encrypted = await encryptSecretMaterial("v", binding, keys);
  for (const elsewhere of [
    { ...binding, context: "prj_2.iterate/secrets/tok" },
    { ...binding, context: "prj_1.iterate/secrets/other" },
    { ...binding, urls: ["https://a.example"] },
    { ...binding, revision: 4 },
  ])
    await expect(decryptSecretMaterial(encrypted, elsewhere, keys)).rejects.toThrow();
  expect(
    await decryptSecretMaterial(
      encrypted,
      { ...binding, urls: ["https://b.example", "https://a.example"] },
      keys,
    ),
  ).toMatchObject({ material: "v" });
});

test("rotation: the previous key opens what the current cannot and says so; without a previous key a foreign ciphertext is refused", async () => {
  const encrypted = await encryptSecretMaterial("v", binding, { current: "old-key" });
  expect(
    await decryptSecretMaterial(encrypted, binding, { current: "new-key", previous: "old-key" }),
  ).toEqual({
    material: "v",
    rotated: true,
  });
  await expect(decryptSecretMaterial(encrypted, binding, { current: "new-key" })).rejects.toThrow();
});

const scripted = (answer: (exchange: Exchange) => Response) => {
  const exchanges: Exchange[] = [];
  const fetchFn = async (request: Request) => {
    const exchange = {
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    };
    exchanges.push(exchange);
    return answer(exchange);
  };
  return { exchanges, fetchFn };
};

/** `user:password` as a Basic credential's base64, UTF-8 first. */
function basic(credential: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(credential)));
}
