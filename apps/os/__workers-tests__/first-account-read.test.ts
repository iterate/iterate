// A new person's first request after their sign-in reads their account (src/oauth.ts
// `accountStateOf`), which may still be starting: the sign-in starts it in the background
// (src/issuer-session.ts `startAccount`), and the consent page says it is being set up while its
// read waits (src/consent-page.server.ts `describeConsent`).
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, onTestFinished, test } from "vitest";
import { describeConsent } from "../src/consent-page.server.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import { startIssuerSession } from "../src/issuer-session.ts";
import { authorizationRequest, helpers } from "./oauth-support.ts";
import { controlPlane, fetchReachesThisWorker, loginPassword, ORIGIN } from "./support.ts";

test("a sign-in reads the person's account in the background, and answers without waiting for it", async () => {
  fetchReachesThisWorker();
  const user = await controlPlane().ensureUser("first-sign-in@example.com");
  const contexts = notStartedContexts();

  const session = await startIssuerSession(
    { ...env, ITERATE_CONTEXT: contexts.namespace },
    new Request(`${ORIGIN}/login`, { method: "POST" }),
    user,
    "/login",
  );

  expect(session).toMatchObject({ setCookie: expect.stringContaining("__Host-itx-session=") });
  expect(contexts).toMatchObject({
    calls: [
      {
        name: accountName(user.id),
        expression: ["itx", "facets", ["get", "account"], ["snapshot"]],
      },
    ],
  });
});

test("the consent page, while the person's account has not started, says it is being set up within four seconds; once the account answers it shows the consent", async () => {
  const email = "consent-while-account-starts@example.com";
  const consentPage = await consentPageOf(email);
  const contexts = notStartedContexts();

  const started = Date.now();
  const whileStarting = await Promise.race([
    consentPage(contexts.namespace),
    new Promise((resolve) => setTimeout(() => resolve("still waiting after 10 s"), 10_000)),
  ]);

  expect(whileStarting).toEqual({ view: { kind: "setting-up" }, platformOrigin: ORIGIN });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(contexts.calls.map((call) => call.name)).toEqual([
    accountName((await controlPlane().ensureUser(email)).id),
  ]);
  expect(await consentPage(env.ITERATE_CONTEXT)).toMatchObject({ view: { kind: "consent" } });
});

test("the consent page, when the platform fails the person's account read, says the account is being set up", async () => {
  const consentPage = await consentPageOf("consent-account-unavailable@example.com");
  // what workerd answers when the connection to the object is lost, twice: the read is sent once
  // more (context-stub.ts), then stands as UNAVAILABLE
  const failing = {
    getByName: () => ({
      invoke: () =>
        Promise.reject(Object.assign(new Error("Network connection lost."), { retryable: true })),
    }),
  } as unknown as typeof env.ITERATE_CONTEXT;

  expect(await consentPage(failing)).toEqual({
    view: { kind: "setting-up" },
    platformOrigin: ORIGIN,
  });
});

/** Context Durable Objects Cloudflare has not started: a call on one waits until the test ends,
 *  when it answers an empty account, so no `waitUntil` outlives the file. `calls` is every call. */
function notStartedContexts() {
  const calls: { name: string; expression: unknown }[] = [];
  const { promise: testOver, resolve } = Promise.withResolvers<{ offset: number; state: object }>();
  onTestFinished(() => resolve({ offset: 0, state: {} }));
  const namespace = {
    getByName: (name: string) => ({
      invoke: (expression: unknown) => {
        calls.push({ name, expression });
        return testOver;
      },
    }),
  } as unknown as typeof env.ITERATE_CONTEXT;
  return { namespace, calls };
}

/** The Durable Object name of the person's account (session.ts `ownerContext`). */
function accountName(userId: string) {
  return DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${userId}`,
  });
}

/** A browser signed in as `email` through the sign-in page, and a client's authorization request
 *  for `/api`: what the consent page describes, as `describeConsent` over `contexts`. */
async function consentPageOf(email: string) {
  fetchReachesThisWorker();
  const login = await exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ email, password: loginPassword(), next: "/login" }),
  });
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const client = await helpers().createClient({
    clientName: "First read",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  const { query } = await authorizationRequest(client.clientId, [`${ORIGIN}/api`]);
  return (contexts: typeof env.ITERATE_CONTEXT) =>
    describeConsent(
      new Request(`${ORIGIN}/oauth2/auth?${query}`, { headers: { cookie } }),
      { ...env, ITERATE_CONTEXT: contexts },
      createExecutionContext(),
      `?${query}`,
    );
}
