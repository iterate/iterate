// __workers-tests__/admin-sign-in.test.ts — a preview's admins sign in through prd
// (src/admin-sign-in.ts): the preview sends the browser to its admin issuer, which asks only who
// they are (the `/oauth2/userinfo` resource, consent.ts `identify`), and an address the preview's
// `admins` lists is signed in there as themselves. This worker plays both: itself at ORIGIN as the
// issuer (prd's part), and, under a second configuration, the preview at PREVIEW whose fetches to
// either origin reach the right one. The preview serves its projects as paths on its own origin, as
// every preview does, so a project's app shares the origin the flow's cookie is on.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import worker from "../src/worker.ts";
import { appConfigOf, platformAddressesOf, sessionSigningSecretOf } from "../src/app-config.ts";
import { signClaims, verifyClaims } from "../src/caller.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { publishConfigWorker } from "../test-support/config-worker.ts";
import { authorizationRequest, call, helpers, issuerApprover } from "./oauth-support.ts";
import { adminCredentials, loginPassword, openSession, ORIGIN } from "./support.ts";

const PREVIEW = "https://pr1-os.iterate-dev-preview.workers.dev";
const previewEnv = {
  ...env,
  APP_CONFIG_URLS__OS: PREVIEW,
  APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
  APP_CONFIG_LOGIN__ADMIN_ISSUER: ORIGIN,
  APP_CONFIG_ADMINS: JSON.stringify(["boss@admins.test"]),
} as typeof env;
const addresses = platformAddressesOf(env, new Request(`${ORIGIN}/`));
const FLOW_COOKIE = "__Host-itx-admin-sign-in";

/** A site that answers with the cookies it was handed, and tries to set the flow's cookie beside
 *  one of its own. */
const SRC_PLANTING_APP = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Planting extends WorkerEntrypoint {
  fetch(request) {
    const headers = new Headers();
    headers.append("Set-Cookie", "${FLOW_COOKIE}=planted; Path=/; Secure; HttpOnly; SameSite=Lax");
    headers.append("Set-Cookie", "theme=light; Path=/");
    return Response.json({ cookie: request.headers.get("cookie") }, { headers });
  }
}`,
};

test("an admin: the issuer asks only who they are, and the preview signs them in as themselves and sends them on", async () => {
  bothOriginsReachable();
  const started = await startSignIn("/oauth2/auth?client_id=x");
  expect(started).toMatchObject({ status: 302 });
  const authorize = new URL(started.headers.get("location")!);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ORIGIN}/oauth2/auth`);
  expect(authorize.searchParams.get("client_id")).toBe(
    `${PREVIEW}/.auth/admin-sign-in/client.json`,
  );
  expect(authorize.searchParams.getAll("resource")).toEqual([addresses.userinfo]);
  // nobody is signed in on the preview yet: only the flow's own cookie
  const flowCookie = cookieOf(started, FLOW_COOKIE);

  const approver = await approverFor("boss@admins.test");
  const view = await approver.consent.describe(authorize.search);
  expect(view).toMatchObject({ kind: "identify", email: "boss@admins.test" });
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  const back = (approval as { redirectTo: string }).redirectTo;
  expect(back.startsWith(`${PREVIEW}/.auth/admin-sign-in/callback?`)).toBe(true);

  const info = vi.spyOn(console, "info");
  const landed = await previewFetch(back, flowCookie);
  expect(landed, await landed.clone().text()).toMatchObject({ status: 302 });
  expect(landed.headers.get("location")).toBe("/oauth2/auth?client_id=x");
  expect(info).toHaveBeenCalledWith({
    event: "admin-sign-in.signed-in",
    email: "boss@admins.test",
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
  expect(signedIn?.principal.email).toBe("boss@admins.test");
  // the sign-in is over: its cookie goes, and the same callback cannot be replayed
  expect(landed.headers.getSetCookie()).toContain(
    `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
});

test("anyone the issuer vouches for but the preview's admins lands back on the sign-in page, signed in nowhere", async () => {
  bothOriginsReachable();
  const started = await startSignIn("/login");
  const authorize = new URL(started.headers.get("location")!);
  const approver = await approverFor("stranger@example.com");
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  const warn = vi.spyOn(console, "warn");
  const refused = await previewFetch(
    (approval as { redirectTo: string }).redirectTo,
    cookieOf(started, FLOW_COOKIE),
  );
  expect(refused).toMatchObject({ status: 303 });
  expect(refused.headers.get("location")).toBe(
    `/login?${new URLSearchParams({
      next: "/login",
      error: "stranger@example.com is not an admin here. Sign in another way.",
    })}`,
  );
  expect(refused.headers.getSetCookie().join()).not.toContain("__Host-itx-session=");
  expect(warn).toHaveBeenCalledWith({
    event: "admin-sign-in.refused-not-admin",
    email: "stranger@example.com",
  });
});

test("a callback without the flow's cookie — another browser, a forged one, or another claim set the same secret signs — signs nobody in", async () => {
  bothOriginsReachable();
  const started = await startSignIn("/login");
  const authorize = new URL(started.headers.get("location")!);
  const approver = await approverFor("boss@admins.test");
  const approval = await approver.consent.approve({ query: authorize.search, projects: [] });
  const back = (approval as { redirectTo: string }).redirectTo;
  // the flow's claims, signed like every platform claim set, apart from the others by their kind
  const secret = await sessionSigningSecretOf(appConfigOf(previewEnv));
  const flow = (await verifyClaims(
    cookieOf(started, FLOW_COOKIE).slice(`${FLOW_COOKIE}=`.length),
    secret,
  )) as Record<string, unknown>;
  expect(flow).toMatchObject({ kind: "admin-sign-in", next: "/login" });
  const identityFlow = cookieOf(
    await previewFetch(`${PREVIEW}/.auth/identity/github?next=%2Flogin`, ""),
    "__Host-itx-github-identity-flow",
  ).slice("__Host-itx-github-identity-flow=".length);
  for (const cookie of [
    "",
    `${FLOW_COOKIE}=forged.signature`,
    // a sign-in's own flow cookie, which the same secret signed
    `${FLOW_COOKIE}=${identityFlow}`,
    // this flow's claims under a sign-in's kind
    `${FLOW_COOKIE}=${await signClaims({ ...flow, kind: "identity-login" }, secret)}`,
  ]) {
    const refused = await previewFetch(back, cookie);
    expect(refused, cookie).toMatchObject({ status: 303 });
    expect(new URL(refused.headers.get("location")!, PREVIEW).searchParams.get("error")).toMatch(
      /expired or began in another browser/,
    );
    expect(refused.headers.getSetCookie().join()).not.toContain("__Host-itx-session=");
  }
  // the same claims under their own kind, signed again, sign the admin in: the rows above were
  // refused for their kind and shape alone
  const landed = await previewFetch(back, `${FLOW_COOKIE}=${await signClaims(flow, secret)}`);
  expect(landed, await landed.clone().text()).toMatchObject({ status: 302 });
  expect(landed.headers.get("location")).toBe("/login");
});

test("a project's app on the preview's origin is never handed the flow's cookie, and cannot set one", async () => {
  const flowCookie = cookieOf(await startSignIn("/login"), FLOW_COOKIE);
  const project = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: "flow-cookie" });
  await publishConfigWorker(project, ["itx", "workers", ["get", { source: SRC_PLANTING_APP }]]);
  const answer = await previewFetch(
    `${PREVIEW}/projects/flow-cookie/site/`,
    `${flowCookie}; theme=dark`,
  );
  expect(answer, await answer.clone().text()).toMatchObject({ status: 200 });
  expect(await answer.json()).toEqual({ cookie: "theme=dark" });
  expect(answer.headers.getSetCookie()).toEqual(["theme=light; Path=/"]);
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

/** A fresh browser starting the preview's admin sign-in, to land on `next`. */
function startSignIn(next: string) {
  return previewFetch(`${PREVIEW}/.auth/admin-sign-in?${new URLSearchParams({ next })}`, "");
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
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === PREVIEW
      ? worker.fetch(request, previewEnv, createExecutionContext())
      : exports.default.fetch(request);
  });
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
