/**
 * The Slack, Google, Cloudflare and GitHub fakes over in-memory state (memory-state.ts): the refusals each
 * answers the way the real service does, GitHub's install-with-OAuth redirect, and the GitHub
 * installation registry's cap. The happy paths are apps/os's to prove, against these same fakes.
 */
import { expect, test } from "vitest";
import { memoryPetshop } from "./memory-state.ts";
import { pkceS256 } from "./seal.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, DEFAULT_INSTALLATION_ID } from "./state.ts";

const CALLBACK = "https://os.example/callback";
const VERIFIER = "a-verifier-long-enough-for-pkce-0123456789";
const BASIC = `Basic ${btoa(`${DEFAULT_CLIENT_ID}:${DEFAULT_CLIENT_SECRET}`)}`;

test.for<[string, (shop: Fakes) => Promise<Response>, object]>([
  [
    "an unknown client at consent",
    (shop) => shop.call(`/oauth/v2/authorize?client_id=nobody&redirect_uri=${CALLBACK}`),
    { status: 400 },
  ],
  [
    "a wrong client secret",
    async (shop) => slackExchange(shop, await slackCode(shop), { client_secret: "wrong" }),
    { body: { ok: false, error: "invalid_client_id" } },
  ],
  [
    "a wrong PKCE verifier",
    async (shop) => slackExchange(shop, await slackCode(shop), { code_verifier: "wrong" }),
    { body: { ok: false, error: "invalid_code_verifier" } },
  ],
  [
    "a replayed code",
    async (shop) => {
      const code = await slackCode(shop);
      await slackExchange(shop, code);
      return slackExchange(shop, code);
    },
    { body: { ok: false, error: "invalid_code" } },
  ],
  [
    "a revoked bot token",
    async (shop) => {
      const { access_token } = await (
        await slackExchange(shop, await slackCode(shop))
      ).json<{
        access_token: string;
      }>();
      const bearer = { authorization: `Bearer ${access_token}` };
      await shop.post("/api/auth.revoke", {}, bearer);
      return shop.post("/api/auth.test", {}, bearer);
    },
    { body: { ok: false, error: "invalid_auth" } },
  ],
])("slack refuses %s", async ([, run, expected]) => {
  const response = await run(fakes());
  expect({ status: response.status, body: await response.json() }).toMatchObject(expected);
});

test.for<[string, (shop: Fakes) => Promise<Response>, object]>([
  [
    "a wrong client secret in the form",
    async (shop) =>
      shop.post("/token", {
        grant_type: "authorization_code",
        code: await googleCode(shop),
        redirect_uri: CALLBACK,
        client_id: DEFAULT_CLIENT_ID,
        client_secret: "wrong",
      }),
    { status: 401, body: { error: "invalid_client" } },
  ],
  [
    "a wrong PKCE verifier",
    async (shop) =>
      shop.post(
        "/token",
        {
          grant_type: "authorization_code",
          code: await googleCode(shop),
          redirect_uri: CALLBACK,
          code_verifier: "wrong",
        },
        { authorization: BASIC },
      ),
    { status: 400, body: { error: "invalid_grant" } },
  ],
  [
    "an access token its client's tokens were expired after",
    async (shop) => {
      const { access_token } = await googleTokens(shop);
      await shop.state.expireAccessTokens(DEFAULT_CLIENT_ID);
      return shop.call("/oauth2/v2/userinfo", {
        headers: { authorization: `Bearer ${access_token}` },
      });
    },
    { status: 401, body: { error: { status: "UNAUTHENTICATED" } } },
  ],
  [
    "a revoked refresh token",
    async (shop) => {
      const { refresh_token } = await googleTokens(shop);
      await shop.call(`/revoke?token=${encodeURIComponent(refresh_token)}`, { method: "POST" });
      return shop.post(
        "/token",
        { grant_type: "refresh_token", refresh_token },
        { authorization: BASIC },
      );
    },
    { status: 400, body: { error: "invalid_grant" } },
  ],
  [
    "a refresh by another client",
    async (shop) => {
      const { refresh_token } = await googleTokens(shop);
      const other = await shop.state.createClient({});
      return shop.post(
        "/token",
        { grant_type: "refresh_token", refresh_token },
        { authorization: `Basic ${btoa(`${other.clientId}:${other.clientSecret}`)}` },
      );
    },
    { status: 400, body: { error: "invalid_grant" } },
  ],
])("google refuses %s", async ([, run, expected]) => {
  const response = await run(fakes());
  expect({ status: response.status, body: await response.json() }).toMatchObject(expected);
});

test("github: installing redirects to the Callback URL with the installer's code, which lists the installation and their role", async () => {
  const shop = fakes();
  await installAcme(shop);
  const installed = await shop.call(
    "/apps/iterate-test/installations/new?state=s1&installation_id=4242",
  );
  const back = Object.fromEntries(new URL(installed.headers.get("location")!).searchParams);
  expect(back).toMatchObject({ installation_id: "4242", setup_action: "install", state: "s1" });
  const bearer = { headers: { authorization: `Bearer ${await userToken(shop, back.code!)}` } };
  expect(await (await shop.call("/user", bearer)).json()).toMatchObject({ login: "ada" });
  expect(await (await shop.call("/user/installations", bearer)).json()).toMatchObject({
    total_count: 1,
    installations: [{ id: 4242, app_slug: "iterate-test", account: { login: "acme" } }],
  });
  expect(await (await shop.call("/user/memberships/orgs/acme", bearer)).json()).toMatchObject({
    state: "active",
    role: "admin",
  });
  const requested = await shop.call(
    "/apps/iterate-test/installations/new?state=s2&installation_id=4242&login=bob&request=1",
  );
  expect(Object.fromEntries(new URL(requested.headers.get("location")!).searchParams)).toEqual({
    setup_action: "request",
    state: "s2",
  });
});

test.for<[string, (shop: Fakes) => Promise<Response>, object]>([
  [
    "an install of another App's installation",
    (shop) => shop.call("/apps/another-app/installations/new?installation_id=4242"),
    { status: 404 },
  ],
  [
    "a replayed code",
    async (shop) => {
      const code = await shop.codeFrom("/login/oauth/authorize", {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: CALLBACK,
      });
      await userToken(shop, code);
      return shop.post("/login/oauth/access_token", {
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
        code,
      });
    },
    { status: 200, body: { error: "bad_verification_code" } },
  ],
  [
    "an authorize code exchanged without the redirect_uri the authorize named",
    async (shop) => {
      const code = await shop.codeFrom("/login/oauth/authorize", {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: CALLBACK,
      });
      return shop.post("/login/oauth/access_token", {
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
        code,
      });
    },
    { status: 200, body: { error: "redirect_uri_mismatch" } },
  ],
  [
    "the membership of a user on none of the organization's installations",
    async (shop) => {
      const code = await shop.codeFrom("/login/oauth/authorize", {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: CALLBACK,
        login: "mallory",
      });
      return shop.call("/user/memberships/orgs/acme", {
        headers: { authorization: `Bearer ${await userToken(shop, code)}` },
      });
    },
    { status: 404 },
  ],
  [
    "a user token on the installation API",
    async (shop) => {
      const code = await shop.codeFrom("/login/oauth/authorize", {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: CALLBACK,
      });
      return shop.call("/installation/repositories", {
        headers: { authorization: `Bearer ${await userToken(shop, code)}` },
      });
    },
    { status: 401 },
  ],
  [
    "the emails of a user who never approved the Email addresses permission",
    async (shop) => {
      const code = await shop.codeFrom("/login/oauth/authorize", {
        client_id: DEFAULT_CLIENT_ID,
        redirect_uri: CALLBACK,
        emails: "none",
      });
      const emails = await shop.call("/user/emails", {
        headers: { authorization: `Bearer ${await userToken(shop, code)}` },
      });
      expect(emails.headers.get("x-accepted-github-permissions")).toBe("emails=read");
      return emails;
    },
    { status: 403, body: { message: "Resource not accessible by integration" } },
  ],
])("github refuses %s", async ([, run, expected]) => {
  const shop = fakes();
  await installAcme(shop);
  const response = await run(shop);
  expect({ status: response.status, body: await response.json() }).toMatchObject(expected);
});

test("github: at the registry's cap the earliest registered installation goes, never the seeded one", async () => {
  const { state } = fakes();
  for (let index = 0; index < 200; index += 1)
    await state.registerApp({ installationId: String(5_000_000_000 + index), publicKeyPem: "k" });
  await state.registerApp({ installationId: "1000000000", publicKeyPem: "k" });
  const ids = Object.keys((await state.getState()).apps);
  expect(ids).toHaveLength(200);
  expect(ids).toEqual(
    expect.arrayContaining([DEFAULT_INSTALLATION_ID, "1000000000", "5000000199"]),
  );
  expect(ids).not.toContain("5000000000");
  expect(ids).not.toContain("5000000001");
});

test("google, as an OpenID provider: a refresh token only for a consent prompt, and an ID token echoing the nonce, signed with the published key", async () => {
  const shop = fakes();
  const exchange = async (query: Record<string, string>) =>
    (
      await shop.post("/token", {
        grant_type: "authorization_code",
        code: await googleCode(shop, { scope: "openid email", nonce: "n-1", ...query }),
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      })
    ).json<{ refresh_token?: string; id_token: string }>();
  const first = await exchange({ email: "ada@example.test" });
  expect(first.refresh_token).toBeUndefined();
  const consented = await exchange({ email: "ada@example.test", prompt: "consent" });
  expect(consented).toMatchObject({ refresh_token: expect.any(String) });
  const [header, payload, signature] = consented.id_token.split(".");
  expect(JSON.parse(atob(payload!.replaceAll("-", "+").replaceAll("_", "/")))).toMatchObject({
    iss: "https://shop.test",
    aud: DEFAULT_CLIENT_ID,
    email: "ada@example.test",
    email_verified: true,
    nonce: "n-1",
  });
  const { keys } = await (await shop.call("/oauth2/v3/certs")).json<{ keys: JsonWebKey[] }>();
  const key = await crypto.subtle.importKey(
    "jwk",
    keys[0]!,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(
    atob(signature!.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      bytes,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  ).toBe(true);
});

type Fakes = ReturnType<typeof fakes>;

/** In-memory fakes, driven by path: `call` answers the request, `post` sends a form, `codeFrom`
 *  follows an authorize redirect to its code. */
function fakes() {
  const shop = memoryPetshop();
  const call = async (path: string, init?: RequestInit) =>
    (await shop.handle(new Request(`https://shop.test${path}`, init)))!;
  return {
    ...shop,
    call,
    post: (path: string, form: Record<string, string>, headers: HeadersInit = {}) =>
      call(path, { method: "POST", headers, body: new URLSearchParams(form) }),
    codeFrom: async (path: string, query: Record<string, string>) =>
      new URL(
        (await call(`${path}?${new URLSearchParams(query)}`)).headers.get("location")!,
      ).searchParams.get("code")!,
  };
}

async function slackCode(shop: Fakes) {
  return shop.codeFrom("/oauth/v2/authorize", {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: await pkceS256(VERIFIER),
  });
}

function slackExchange(shop: Fakes, code: string, form: Record<string, string> = {}) {
  return shop.post("/api/oauth.v2.access", {
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
    code,
    code_verifier: VERIFIER,
    ...form,
  });
}

async function googleCode(shop: Fakes, query: Record<string, string> = { prompt: "consent" }) {
  return shop.codeFrom("/o/oauth2/v2/auth", {
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: await pkceS256(VERIFIER),
    ...query,
  });
}

async function googleTokens(shop: Fakes) {
  const form = {
    grant_type: "authorization_code",
    code: await googleCode(shop),
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
  };
  const response = await shop.post("/token", form, { authorization: BASIC });
  return response.json<{ access_token: string; refresh_token: string }>();
}

/** An organization installation `4242` of the App `iterate-test`: ada is its admin, bob a member. */
function installAcme(shop: Fakes) {
  return shop.state.registerApp({
    installationId: "4242",
    appSlug: "iterate-test",
    publicKeyPem: "unused",
    callbackUrl: CALLBACK,
    account: { login: "acme" },
    users: [
      { login: "ada", role: "admin" },
      { login: "bob", role: "member" },
    ],
  });
}

/** A GitHub user code → its user token, the client credentials as query parameters. */
async function userToken(shop: Fakes, code: string) {
  const query = new URLSearchParams({
    client_id: DEFAULT_CLIENT_ID,
    client_secret: DEFAULT_CLIENT_SECRET,
    code,
    redirect_uri: CALLBACK,
  });
  const response = await shop.call(`/login/oauth/access_token?${query}`, { method: "POST" });
  return (await response.json<{ access_token: string }>()).access_token;
}
