// secrets.test.ts — the secret cell's pure half (secrets.ts): the placeholder substitution as a
// table, the record normalization, and the two refresh strategies against a scripted fetch.

import { expect, test } from "vitest";
import {
  normalizeSecretRecord,
  ProjectSecretRefused,
  refreshSecretMaterial,
  secretNamesReferenced,
  substituteProjectSecrets,
  type SecretMaterial,
} from "./secrets.ts";

// ── substitution ── `substituteProjectSecrets`, as a table: `{ url?, headers?, resolve?, becomes }`
// rows. Every `getSecret("/secrets/NAME")` placeholder in the URL (path and query — matched as the
// URL parser spelled it, `"` → %22, `{ ` → %7B%20) and the headers is replaced by its value
// (`{ field: "a.b" }` picks one string out of a JSON material — apps/os's grammar for a URL or a
// header); a placeholder with no stored secret, or a field the value has no string at, refuses,
// naming the placeholder and where it sat; substituted values are never rescanned; a NEW Request
// only when something changed (the rebuild is WS-safe — method, Upgrade and body survive it).
// `becomes` is what the door answered: the rebuilt Request's URL and headers (a subset),
// "unchanged" (the ORIGINAL Request — no rebuild), or `{ refused }` — the `ProjectSecretRefused` message.

const secrets: Record<string, SecretMaterial> = {
  a: "alpha",
  b: "bravo",
  "api.key_v-2": "REAL",
  tg: JSON.stringify({ bot: { token: "123:abc", id: 7 }, plain: "p" }),
  obj: { accessToken: "AT", nested: { deep: "D" } },
};
const rows: {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  resolve?: (name: string) => SecretMaterial | null;
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
    resolve: (name) => (name === "outer" ? 'getSecret("/secrets/inner")' : "INNER-LEAKED"),
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
    name: "`{ field }` at a path the JSON value has no string at refuses, naming the placeholder and where it sat",
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
    name: "`{ field }` on a non-JSON value refuses",
    headers: { "x-auth": 'getSecret("/secrets/a", { field: "x" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/a", { field: "x" }) in header "x-auth" names a field, but the secret is not a JSON value',
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
      row.resolve || ((name) => secrets[name] ?? null),
    ).then(
      (out) =>
        out === request ? "unchanged" : { url: out.url, headers: Object.fromEntries(out.headers) },
      (error: unknown) =>
        error instanceof ProjectSecretRefused ? { refused: error.message } : Promise.reject(error),
    );
    if (typeof row.becomes === "string") expect(became).toBe(row.becomes);
    else expect(became).toMatchObject(row.becomes);
  });

test("a mintable miss (no material, a missing field) is marked so the cell knows a strategy may fill it; the other refusals are not", async () => {
  const miss = (resolve: (name: string) => SecretMaterial | null, header: string) =>
    substituteProjectSecrets(
      new Request("https://api.example.com/", { headers: { authorization: header } }),
      resolve,
    ).then(
      () => "substituted",
      (error: ProjectSecretRefused) => error.mintable,
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

test("secretNamesReferenced: the distinct names a request's URL and headers name", () => {
  expect(
    secretNamesReferenced(
      new Request('https://api.example.com/?k=getSecret("/secrets/q")', {
        headers: {
          authorization: 'Bearer getSecret("/secrets/tok", { field: "accessToken" })',
          "x-b": 'getSecret("/secrets/tok")',
        },
      }),
    ),
  ).toEqual(["q", "tok"]);
  expect(secretNamesReferenced(new Request("https://api.example.com/"))).toEqual([]);
});

// ── the record ── `normalizeSecretRecord`: what `itx.secrets.set(name, material, options)` stores.
test("normalizeSecretRecord: pins are origins (deduped), a strategy is named and lies within the pin", () => {
  expect(
    normalizeSecretRecord("v", {
      urls: ["https://api.example.com/v1/x", "https://api.example.com"],
    }),
  ).toEqual({ material: "v", urls: ["https://api.example.com"], refresh: null });
  expect(normalizeSecretRecord({ a: "b" }, undefined)).toEqual({
    material: { a: "b" },
    urls: [],
    refresh: null,
  });
  expect(
    normalizeSecretRecord(
      { username: "u", password: "p" },
      {
        urls: ["https://www.waitrose.com"],
        refresh: { kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" },
      },
    ).refresh,
  ).toEqual({ kind: "waitrose-session", graphqlUrl: "https://www.waitrose.com/api/graphql" });
  expect(() => normalizeSecretRecord("v", { urls: ["not a url"] })).toThrow();
  expect(() => normalizeSecretRecord(42, undefined)).toThrow(/string or a JSON object/);
  expect(() =>
    normalizeSecretRecord("v", { refresh: { kind: "magic", tokenEndpoint: "https://x" } }),
  ).toThrow(/refresh\.kind is one of oauth-refresh-token, waitrose-session/);
  expect(() =>
    normalizeSecretRecord("v", {
      urls: ["https://api.example.com"],
      refresh: { kind: "oauth-refresh-token", tokenEndpoint: "https://elsewhere.example/token" },
    }),
  ).toThrow(/outside the pin/);
});

// ── the strategies ── `refreshSecretMaterial(strategy, material, fetch)`: a scripted fetch records
// the exchange and answers; the NEXT material is what the cell would store.
type Exchange = { url: string; headers: Record<string, string>; body: string };
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
    JSON.stringify({ clientId: "public-client", refreshToken: "RT" }),
    pub.fetchFn,
  );
  expect(next).toEqual({ clientId: "public-client", refreshToken: "RT", accessToken: "AT" });
  expect(pub.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(pub.exchanges[0]!.body).toBe(
    "grant_type=refresh_token&refresh_token=RT&client_id=public-client",
  );
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
  expect(sent.variables).toEqual({
    input: { clientId: "ANDROID_APP", password: "hunter2", username: "mum@example.com" },
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
