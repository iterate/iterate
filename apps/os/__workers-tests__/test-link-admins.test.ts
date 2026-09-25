// __workers-tests__/test-link-admins.test.ts — a preview's sign-in link redeemed only by an admin
// (src/test-link-admins.ts): the link sends the browser to the admins' issuer, which asks only who
// they are (the `/oauth2/userinfo` resource, consent.ts `identify`), and an address the preview's
// `login.testLink.admins.emails` names is signed in as the link's test person. This worker plays
// both: itself at ORIGIN as the issuer (prd's part), and, under a second configuration, the preview
// at PREVIEW whose fetches to either origin reach the right one.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import worker from "../src/worker.ts";
import { platformAddressesOf } from "../src/app-config.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { mintTestLink, TEST_LINK_PATH } from "../src/test-link.ts";
import { authorizationRequest, call, helpers, issuerApprover } from "./oauth-support.ts";
import { loginPassword, ORIGIN } from "./support.ts";

const PREVIEW = "https://pr1-os.iterate-dev-preview.workers.dev";
const previewEnv = {
  ...env,
  APP_CONFIG_URLS__OS: PREVIEW,
  APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
  APP_CONFIG_LOGIN__TEST_LINK__ADMINS__ISSUER: ORIGIN,
  APP_CONFIG_LOGIN__TEST_LINK__ADMINS__EMAILS: "*@admins.test",
} as typeof env;
const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/`));

test("an admin's link: the issuer asks only who they are, and the preview signs them in as the test person", async () => {
  bothOriginsReachable();
  const clicked = await openLink("pr1@preview.iterate.test");
  expect(clicked).toMatchObject({ status: 302 });
  const authorize = new URL(clicked.headers.get("location")!);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ORIGIN}/oauth2/auth`);
  expect(authorize.searchParams.get("client_id")).toBe(`${PREVIEW}${TEST_LINK_PATH}/client.json`);
  expect(authorize.searchParams.getAll("resource")).toEqual([addresses.userinfo]);
  // nobody is signed in on the preview yet: only the check's own cookie
  const flowCookie = cookieOf(clicked, "__Host-iterate-test-link");

  const approver = await approverFor("boss@admins.test");
  const view = await approver.consent.describe(authorize.search);
  expect(view).toMatchObject({ kind: "identify", email: "boss@admins.test" });
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  expect(approval).toHaveProperty("redirectTo");
  const back = (approval as { redirectTo: string }).redirectTo;
  expect(back.startsWith(`${PREVIEW}${TEST_LINK_PATH}/callback?`)).toBe(true);

  const info = vi.spyOn(console, "info");
  onTestFinished(() => info.mockRestore());
  const landed = await previewFetch(back, flowCookie);
  expect(landed, await landed.clone().text()).toMatchObject({ status: 302 });
  expect(landed.headers.get("location")).toBe(`${PREVIEW}/login`);
  expect(info).toHaveBeenCalledWith({
    event: "test-link.redeemed",
    admin: "boss@admins.test",
    email: "pr1@preview.iterate.test",
  });
  const session = appSession(
    previewEnv.BROWSER_SESSION,
    new Request(PREVIEW, { headers: { cookie: cookieOf(landed, "__Host-itx-session") } }),
  )!;
  const signedIn = await authorizationForToken(
    previewEnv,
    (await session.bearer())!,
    platformAddressesOf(previewEnv, new Request(`${PREVIEW}/`)),
    "browser-session",
  );
  expect(signedIn?.principal.email).toBe("pr1@preview.iterate.test");
  // the check is over: its cookie goes, and the same callback cannot be replayed
  expect(landed.headers.getSetCookie()).toContain(
    "__Host-iterate-test-link=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  );
});

test("anyone the admins' issuer vouches for but the preview's admins is refused, and nobody is signed in", async () => {
  bothOriginsReachable();
  const clicked = await openLink("pr1@preview.iterate.test");
  const authorize = new URL(clicked.headers.get("location")!);
  const approver = await approverFor("stranger@example.com");
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());
  const refused = await previewFetch(
    (approval as { redirectTo: string }).redirectTo,
    cookieOf(clicked, "__Host-iterate-test-link"),
  );
  expect(refused).toMatchObject({ status: 403 });
  expect(await refused.text()).toMatch(
    /stranger@example\.com may not use this preview's sign-in link/,
  );
  expect(refused.headers.getSetCookie().join()).not.toContain("__Host-itx-session=");
  expect(warn).toHaveBeenCalledWith({
    event: "test-link.refused-not-admin",
    email: "stranger@example.com",
  });
});

test("a callback without the check's cookie — another browser, or a forged one — is refused", async () => {
  bothOriginsReachable();
  const clicked = await openLink("pr1@preview.iterate.test");
  const authorize = new URL(clicked.headers.get("location")!);
  const approver = await approverFor("boss@admins.test");
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  const back = (approval as { redirectTo: string }).redirectTo;
  for (const cookie of ["", "__Host-iterate-test-link=forged.signature"]) {
    const refused = await previewFetch(back, cookie);
    expect(refused).toMatchObject({ status: 403 });
    expect(await refused.text()).toMatch(/expired or began in another browser/);
  }
});

test("a userinfo token says who its person is and nothing else: /api refuses it, and its grant reaches no project", async () => {
  bothOriginsReachable();
  const approver = await approverFor("userinfo-reader@example.com");
  const client = await helpers().createClient({
    clientName: "Userinfo reader",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  // asking for more changes nothing: the resource decides
  const { query, verifier } = await authorizationRequest(client.clientId, [addresses.userinfo]);
  query.set("scope", "iterate account admin");
  const approval = await approver.consent.approve({ query: `?${query}`, projects: ["*"] });
  const code = new URL((approval as { redirectTo: string }).redirectTo).searchParams.get("code")!;
  const exchanged = await call("/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: "https://client.test/callback",
      code_verifier: verifier,
      resource: addresses.userinfo,
    }),
  });
  const token = await exchanged.json<{ access_token: string; scope: string }>();
  expect(token).toMatchObject({ scope: "iterate" });
  const userinfo = await call("/oauth2/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  expect(await userinfo.json()).toEqual({
    sub: expect.stringMatching(/^user_/),
    email: "userinfo-reader@example.com",
  });
  expect(await authorizationForToken(env, token.access_token, addresses, "api")).toBeNull();
  const api = await call("/api", {
    method: "POST",
    body: "",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  expect(api).toMatchObject({ status: 401 });
});

/** A fresh browser opening a link minted for this preview, naming `email`. */
async function openLink(email: string) {
  const token = await mintTestLink({
    key: env.APP_CONFIG_SECRETS__KEY!,
    audience: PREVIEW,
    email,
    next: `${PREVIEW}/login`,
    clients: [],
    expiresAt: Date.now() + 10 * 60_000,
  });
  return previewFetch(`${PREVIEW}${TEST_LINK_PATH}?t=${token}`, "");
}

function previewFetch(url: string, cookie: string) {
  return worker.fetch(
    new Request(url, { redirect: "manual", headers: cookie ? { cookie } : {} }),
    previewEnv,
    createExecutionContext(),
  );
}

/** `fetch` reaches this worker as the issuer at ORIGIN and as the preview at PREVIEW, until the test
 *  finishes: the issuer reads the preview's client metadata, the preview exchanges its code. */
function bothOriginsReachable() {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === PREVIEW
      ? worker.fetch(request, previewEnv, createExecutionContext())
      : exports.default.fetch(request);
  });
  onTestFinished(() => spy.mockRestore());
}

/** The consent capability of `email`'s issuer session at ORIGIN, signed in with the password. */
async function approverFor(email: string) {
  const login = await call("/login", {
    method: "POST",
    body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
  });
  return issuerApprover(login.headers.get("set-cookie")!.split(";")[0]!);
}

/** `name=value` of the cookie `response` sets under `name`. */
function cookieOf(response: Response, name: string) {
  const cookie = response.headers.getSetCookie().find((each) => each.startsWith(`${name}=`));
  expect(cookie, `${name} set`).toBeDefined();
  return cookie!.split(";")[0]!;
}
