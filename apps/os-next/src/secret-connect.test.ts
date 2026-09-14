// secret-connect.test.ts — the OAuth connect half (secret-connect.ts) as pure rows: the options
// normalized, the authorize URL with PKCE, the code exchange against a scripted token endpoint,
// and the `clientAuth` knob both halves share with the refresh strategy (secrets.ts).

import { expect, test } from "vitest";
import {
  beginSecretConnect,
  completeSecretConnect,
  normalizeSecretConnect,
} from "./secret-connect.ts";
import { refreshSecretMaterial } from "./secrets.ts";

const PROVIDER = {
  authorizationEndpoint: "https://auth.example/oauth/authorize",
  tokenEndpoint: "https://auth.example/oauth/token",
};

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

test("normalizeSecretConnect: the pin defaults to the token endpoint's origin, must contain it when given, and clientAuth defaults to basic", () => {
  expect(normalizeSecretConnect({ ...PROVIDER, clientId: "c" })).toMatchObject({
    urls: ["https://auth.example"],
    clientAuth: "basic",
    extra: {},
  });
  expect(
    normalizeSecretConnect({
      ...PROVIDER,
      clientId: "c",
      clientSecret: "s",
      clientAuth: "body",
      scope: "repo",
      urls: ["https://api.example/v1", "https://auth.example/x"],
      extra: { access_type: "offline" },
    }),
  ).toEqual({
    authorizationEndpoint: PROVIDER.authorizationEndpoint,
    tokenEndpoint: PROVIDER.tokenEndpoint,
    clientId: "c",
    clientSecret: "s",
    clientAuth: "body",
    scope: "repo",
    urls: ["https://api.example", "https://auth.example"],
    extra: { access_type: "offline" },
  });
  expect(() =>
    normalizeSecretConnect({ ...PROVIDER, clientId: "c", urls: ["https://api.example"] }),
  ).toThrow(/outside the pin/);
  expect(() => normalizeSecretConnect({ ...PROVIDER, clientId: "" })).toThrow(/clientId/);
  expect(() =>
    normalizeSecretConnect({ ...PROVIDER, authorizationEndpoint: "ftp://x", clientId: "c" }),
  ).toThrow(/http\(s\)/);
});

test("beginSecretConnect: the authorize URL carries the code request with PKCE S256, the signed state, the scope and the extra parameters; the pending record keeps what the exchange needs", async () => {
  const options = normalizeSecretConnect({
    ...PROVIDER,
    clientId: "c",
    clientSecret: "sekrit-value",
    scope: "repo",
    extra: { access_type: "offline", prompt: "consent" },
  });
  const { pending, authorizationUrl } = await beginSecretConnect(options, {
    redirectUri: "https://os.example/.auth/connect/callback",
    state: "signed-state",
    nonce: "n1",
    now: 1000,
  });
  const url = new URL(authorizationUrl);
  expect(url.origin + url.pathname).toBe(PROVIDER.authorizationEndpoint);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "c",
    redirect_uri: "https://os.example/.auth/connect/callback",
    state: "signed-state",
    code_challenge_method: "S256",
    scope: "repo",
    access_type: "offline",
    prompt: "consent",
  });
  // the challenge is the S256 of the verifier the pending record keeps
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
    tokenEndpoint: PROVIDER.tokenEndpoint,
    clientId: "c",
    clientSecret: "sekrit-value",
    clientAuth: "basic",
    urls: ["https://auth.example"],
    redirectUri: "https://os.example/.auth/connect/callback",
    nonce: "n1",
    until: 1000 + 10 * 60_000,
  });
  // the secret never rides the URL
  expect(authorizationUrl).not.toContain("sekrit-value");
  expect(authorizationUrl).not.toContain(pending.codeVerifier);
});

test("completeSecretConnect: the code exchange (HTTP Basic, PKCE verifier, redirect_uri) yields the secret's first record with the refresh strategy at the same endpoint", async () => {
  const options = normalizeSecretConnect({ ...PROVIDER, clientId: "c", clientSecret: "s" });
  const { pending } = await beginSecretConnect(options, {
    redirectUri: "https://os.example/.auth/connect/callback",
    state: "st",
    nonce: "n",
  });
  const provider = scripted(() =>
    Response.json({ access_token: "AT", refresh_token: "RT", token_type: "bearer" }),
  );
  const record = await completeSecretConnect(pending, "the-code", provider.fetchFn);
  expect(record).toEqual({
    material: { clientId: "c", clientSecret: "s", accessToken: "AT", refreshToken: "RT" },
    urls: ["https://auth.example"],
    refresh: { kind: "oauth-refresh-token", tokenEndpoint: PROVIDER.tokenEndpoint },
  });
  expect(provider.exchanges).toEqual([
    {
      url: PROVIDER.tokenEndpoint,
      headers: expect.objectContaining({
        authorization: `Basic ${btoa("c:s")}`,
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: `grant_type=authorization_code&code=the-code&redirect_uri=${encodeURIComponent("https://os.example/.auth/connect/callback")}&code_verifier=${pending.codeVerifier}`,
    },
  ]);
  const refused = scripted(() => new Response("", { status: 400 }));
  await expect(completeSecretConnect(pending, "bad", refused.fetchFn)).rejects.toThrow(
    /connect: the token endpoint answered 400/,
  );
});

test('clientAuth: "body" puts client_id + client_secret in the form for both grants (GitHub\'s shape) and sends no Basic header', async () => {
  const options = normalizeSecretConnect({
    ...PROVIDER,
    clientId: "c",
    clientSecret: "s",
    clientAuth: "body",
  });
  const { pending } = await beginSecretConnect(options, {
    redirectUri: "https://os.example/cb",
    state: "st",
    nonce: "n",
  });
  const exchange = scripted(() => Response.json({ access_token: "AT", refresh_token: "RT" }));
  const record = await completeSecretConnect(pending, "code", exchange.fetchFn);
  expect(exchange.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(exchange.exchanges[0]!.body).toContain("client_id=c&client_secret=s");
  expect(record.refresh).toEqual({
    kind: "oauth-refresh-token",
    tokenEndpoint: PROVIDER.tokenEndpoint,
    clientAuth: "body",
  });
  // the refresh strategy honours the same knob
  const refresh = scripted(() => Response.json({ access_token: "AT2" }));
  await refreshSecretMaterial(record.refresh!, record.material, refresh.fetchFn);
  expect(refresh.exchanges[0]!.headers.authorization).toBeUndefined();
  expect(refresh.exchanges[0]!.body).toBe(
    "grant_type=refresh_token&refresh_token=RT&client_id=c&client_secret=s",
  );
});
