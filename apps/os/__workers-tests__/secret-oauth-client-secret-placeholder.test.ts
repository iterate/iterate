// __workers-tests__/secret-oauth-client-secret-placeholder.test.ts — `beginOAuth` with a client
// secret another secret holds (`clientSecret: 'getSecret("/secrets/<name>")'`, the placeholder
// lifecycle is ../src/secret-oauth.ts's header): the exchange and refresh via Basic and the form,
// rotation, the refusals at `beginOAuth`, and `clientSecretFor` refused to every caller but the
// platform.
//
// THE PROVIDER IS IN-PROCESS: the secret facet's terminal `fetch` is the isolate's global fetch,
// answered below at https://provider.test: a token endpoint that authenticates the client by HTTP
// Basic or the form (a refused client gets GitHub's HTTP 200 `{ error }`), and an API that takes the
// latest access token. Every token request is recorded as the endpoint saw it.
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { errorCode } from "iterate/lib";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { hmacSha256Hex } from "../src/secrets.ts";
import { ORIGIN, projectWithMember } from "./support.ts";

const PROVIDER = "https://provider.test";
const CLIENT_ID = "the-client";
const PLACEHOLDER = 'getSecret("/secrets/provider-client-secret")';
const OPTIONS = {
  authorizationEndpoint: `${PROVIDER}/authorize`,
  tokenEndpoint: `${PROVIDER}/token`,
  clientId: CLIENT_ID,
  clientSecret: PLACEHOLDER,
  scope: "repo",
};

test.for(["client_secret_basic", "client_secret_post"] as const)(
  "%s: the exchange and every refresh send the value the named secret holds, the record keeps the placeholder, and a rotation takes effect at the next refresh",
  async (clientAuth) => {
    const member = await projectWithMember(`oauth-placeholder-${clientAuth.slice(14)}`);
    const provider = fakeProvider("client-secret-1");
    const via = clientAuth === "client_secret_basic" ? "basic" : "form";
    await member.itx.secrets.set("/secrets/provider-client-secret", "client-secret-1", {
      urls: [PROVIDER],
    });

    const { authorizationUrl } = await member.itx.secrets.beginOAuth("/secrets/provider", {
      ...OPTIONS,
      clientAuth,
    });
    expect(authorizationUrl).not.toContain("client-secret-1");
    const back = await callback(member.cookie, authorizationUrl);
    expect({ status: back.status, text: await back.text() }).toEqual({
      status: 200,
      text: expect.stringContaining("Done: the secret /secrets/provider"),
    });
    expect(provider).toMatchObject({
      tokenRequests: [{ grant: "authorization_code", via, clientSecret: "client-secret-1" }],
    });
    expect(await holds(member.itx, "/secrets/provider", PLACEHOLDER, "clientSecret")).toBe(true);
    expect(await holds(member.itx, "/secrets/provider", "client-secret-1", "clientSecret")).toBe(
      false,
    );

    expect(await me(member.itx)).toBe(200);
    provider.accessToken = "revoked";
    expect(await me(member.itx)).toBe(200);
    expect(provider.tokenRequests.at(-1)).toEqual({
      grant: "refresh_token",
      via,
      clientSecret: "client-secret-1",
    });

    provider.clientSecret = "client-secret-2";
    await member.itx.secrets.set("/secrets/provider-client-secret", "client-secret-2", {
      urls: [PROVIDER],
    });
    provider.accessToken = "revoked";
    expect(await me(member.itx)).toBe(200);
    expect(provider.tokenRequests.at(-1)).toEqual({
      grant: "refresh_token",
      via,
      clientSecret: "client-secret-2",
    });
    expect(await holds(member.itx, "/secrets/provider", PLACEHOLDER, "clientSecret")).toBe(true);
    expect(provider.tokenRequests).toHaveLength(3);
  },
);

test("a client secret placeholder that cannot resolve is refused at beginOAuth, before anyone is sent to consent; a field of a JSON secret pinned to the token endpoint is one that can", async () => {
  const member = await projectWithMember("oauth-placeholder-refused");
  const provider = fakeProvider("client-secret-1");
  await member.itx.secrets.set("/secrets/elsewhere", "client-secret-1", {
    urls: ["https://elsewhere.test"],
  });
  await member.itx.secrets.set(
    "/secrets/provider-app",
    { clientSecret: "client-secret-1" },
    { urls: [PROVIDER] },
  );
  const rows = [
    {
      clientSecret: 'getSecret("/secrets/elsewhere")',
      outcome:
        "the secret /secrets/elsewhere is pinned to https://elsewhere.test, not https://provider.test",
    },
    {
      clientSecret: 'getSecret("/secrets/never-set")',
      outcome: "/secrets/never-set holds no secret",
    },
    {
      clientSecret: 'getSecret("/secrets/provider-app")',
      outcome:
        '/secrets/provider-app is a JSON object: name its field, getSecret("/secrets/provider-app", { field: "…" })',
    },
    {
      clientSecret: 'getSecret("/secrets/provider-app", { field: "secret" })',
      outcome: '/secrets/provider-app has no string at field "secret"',
    },
    {
      clientSecret: 'getSecret("/secrets/provider")',
      outcome: "names /secrets/provider itself",
    },
    { clientSecret: `Basic ${PLACEHOLDER}`, outcome: "one placeholder and nothing else" },
    {
      clientSecret: 'getSecret("/provider-client-secret")',
      outcome: "one placeholder and nothing else",
    },
    {
      clientSecret: 'getSecret("/secrets/provider-app", { field: "clientSecret" })',
      outcome: "begun",
    },
  ];
  const outcomes = [];
  for (const { clientSecret } of rows)
    outcomes.push({
      clientSecret,
      outcome: await member.itx.secrets
        .beginOAuth("/secrets/provider", { ...OPTIONS, clientSecret })
        .then(
          () => "begun",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
    });
  expect(outcomes).toEqual(
    rows.map(({ clientSecret, outcome }) => ({
      clientSecret,
      outcome: outcome === "begun" ? outcome : expect.stringContaining(outcome),
    })),
  );
  expect(provider).toMatchObject({ tokenRequests: [] });
});

test("no caller but the platform reads a client secret out: `itx.secrets.clientSecretFor` and the `secret` facet's `clientSecretFor` are refused FORBIDDEN to a project member, and answer the platform", async () => {
  const member = await projectWithMember("oauth-placeholder-forbidden");
  await member.itx.secrets.set("/secrets/provider-client-secret", "client-secret-1", {
    urls: [PROVIDER],
  });
  const input = { origin: PROVIDER };
  const byMember = [
    await outcomeOf(() =>
      member.itx.invoke([
        "itx",
        "secrets",
        ["clientSecretFor", "/secrets/provider-client-secret", input],
      ]),
    ),
    await outcomeOf(() =>
      member.itx
        .cd("/secrets/provider-client-secret")
        .invoke(["itx", "facets", ["get", "secret"], ["clientSecretFor", input]]),
    ),
  ];
  expect(byMember).toEqual(["FORBIDDEN", "FORBIDDEN"]);
  const root = env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId: member.projectId, path: "/" }),
  );
  const call = [
    "itx",
    "builtins",
    "secrets",
    ["clientSecretFor", "/secrets/provider-client-secret", input],
  ];
  expect(await outcomeOf(() => root.invoke(call, [], { principal: null }))).toBe("FORBIDDEN");
  expect(await root.invoke(call, [], { principal: null, platform: true })).toBe("client-secret-1");
});

// ── helpers ──

/** The provider at https://provider.test, answering this isolate's `fetch` for the rest of the test
 *  (the platform's own origin goes to this worker, every other through). `clientSecret` is the one
 *  its token endpoint accepts for `CLIENT_ID`; setting `accessToken` revokes the one it issued. */
function fakeProvider(clientSecret: string) {
  const provider = {
    clientSecret,
    accessToken: "",
    refreshToken: "",
    tokenRequests: [] as { grant: string | null; via: "basic" | "form"; clientSecret: string }[],
  };
  let issued = 0;
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ORIGIN) return exports.default.fetch(request);
    if (url.origin !== PROVIDER) return through(request);
    if (url.pathname === "/me")
      return request.headers.get("authorization") === `Bearer ${provider.accessToken}`
        ? Response.json({ login: "octocat" })
        : new Response("expired", { status: 401 });
    if (url.pathname !== "/token") return new Response("not found", { status: 404 });
    const form = new URLSearchParams(await request.text());
    const basic = /^Basic (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const decoded = basic ? atob(basic) : "";
    const client = basic
      ? {
          id: decoded.slice(0, decoded.indexOf(":")),
          secret: decoded.slice(decoded.indexOf(":") + 1),
        }
      : { id: form.get("client_id"), secret: form.get("client_secret") ?? "" };
    provider.tokenRequests.push({
      grant: form.get("grant_type"),
      via: basic ? "basic" : "form",
      clientSecret: client.secret,
    });
    if (client.id !== CLIENT_ID || client.secret !== provider.clientSecret)
      return Response.json({ error: "incorrect_client_credentials" });
    if (
      form.get("grant_type") === "refresh_token" &&
      form.get("refresh_token") !== provider.refreshToken
    )
      return Response.json({ error: "bad_refresh_token" });
    issued += 1;
    provider.accessToken = `access-${issued}`;
    provider.refreshToken = `refresh-${issued}`;
    return Response.json({
      access_token: provider.accessToken,
      refresh_token: provider.refreshToken,
      token_type: "bearer",
    });
  });
  return provider;
}

/** The human back at the platform's callback from consent: the code, and the signed `state` the
 *  authorize URL carried, with their browser's session cookie. */
function callback(cookie: string, authorizationUrl: string): Promise<Response> {
  const authorize = new URL(authorizationUrl);
  const back = new URL(authorize.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", "the-code");
  back.searchParams.set("state", authorize.searchParams.get("state")!);
  return exports.default.fetch(new Request(back, { headers: { cookie }, redirect: "manual" }));
}

/** The provider's API with the latest access token, through egress: its status. */
async function me(itx: Member["itx"]): Promise<number> {
  const response: Response = await itx.fetch(
    new Request(`${PROVIDER}/me`, {
      headers: { authorization: 'Bearer getSecret("/secrets/provider", { field: "accessToken" })' },
    }),
  );
  await response.body?.cancel();
  return response.status;
}

/** Whether the secret at `path` holds `value` at `field`, asked without reading it: its facet
 *  verifies an HMAC keyed with `value`. */
async function holds(itx: Member["itx"], path: string, value: string, field: string) {
  return itx.secrets.verifyHmac(path, {
    payload: "probe",
    signature: await hmacSha256Hex(value, "probe"),
    field,
  }) as Promise<boolean>;
}

/** What a call came to: `"answered"`, or the code it was refused with (the message when uncoded). */
async function outcomeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    return errorCode(error) ?? String(error);
  }
}

type Member = Awaited<ReturnType<typeof projectWithMember>>;
