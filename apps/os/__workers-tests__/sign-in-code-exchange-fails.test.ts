// A sign-in whose last step fails on the platform's side (src/issuer-session.ts): the code exchange
// against the issuer's own /oauth2/token, which the browser session bounds at 10 s. The person is
// sent back to the sign-in page with the error, and the failure is logged as a platform failure
// naming the person, so it joins the line the token request logged about the hop it waited on.
// And the token endpoint's own grant checks (src/oauth.ts `accountStateOf`) ride out a deploy's
// Durable Object reset, so a sign-in during a deploy does not fail at all.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { platformAddressesOf } from "../src/app-config.ts";
import { authorizationServerFetch } from "../src/oauth.ts";
import { clearLoginCookie } from "../src/password-and-code-sign-in.ts";
import { authorizationRequest, helpers } from "./oauth-support.ts";
import { controlPlane, loginPassword, ORIGIN } from "./support.ts";

test("a code exchange that times out sends the person back to the sign-in page with the error, logged as a platform failure", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error(`Unexpected external fetch: ${url}`);
    // what `AbortSignal.timeout(10_000)` rejects the exchange with, without the ten seconds
    if (url.pathname === "/oauth2/token")
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return exports.default.fetch(request);
  });
  const warn = vi.spyOn(console, "warn");

  const response = await exports.default.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        email: "slow-exchange@example.com",
        password: loginPassword(),
        next: "/login",
      }),
    }),
  );

  expect(response).toMatchObject({ status: 303 });
  // no issuer session: only the pending code's cookie, dropped
  expect(response.headers.getSetCookie()).toEqual([clearLoginCookie]);
  const back = new URL(response.headers.get("location")!, ORIGIN);
  expect(back).toMatchObject({ pathname: "/login" });
  expect(Object.fromEntries(back.searchParams)).toEqual({
    next: "/login",
    error: "Sign-in failed on our side. Try again.",
    email: "slow-exchange@example.com",
    method: "password",
  });
  expect(warn).toHaveBeenCalledWith({
    event: "issuer.platform-failure-sign-in",
    name: "code-exchange",
    reason: "timeout",
    message: "The operation was aborted due to timeout",
    waitedMs: expect.any(Number),
    userId: (await controlPlane().ensureUser("slow-exchange@example.com")).id,
  });
});

test("a token endpoint that answers a 500 sends the person back to the sign-in page with the error, logged as a platform failure", async () => {
  const warn = vi.spyOn(console, "warn");
  const response = await signInWhile("failing-exchange@example.com", async () =>
    Response.json({ error: "server_error" }, { status: 500 }),
  );
  expectBackOnSignInPage(response, "failing-exchange@example.com");
  expect(warn).toHaveBeenCalledWith({
    event: "issuer.platform-failure-sign-in",
    name: "code-exchange",
    reason: "token-endpoint",
    message: "Iterate token exchange failed (500). Try again.",
    waitedMs: expect.any(Number),
    userId: (await controlPlane().ensureUser("failing-exchange@example.com")).id,
  });
});

test("a token endpoint whose answer is no OAuth response at all (an uncaught exception) is the same platform failure", async () => {
  const warn = vi.spyOn(console, "warn");
  // what the token endpoint answers when its grant check throws: no OAuth error body, which
  // oauth4webapi reads as "not a conform Token Endpoint response"
  const response = await signInWhile(
    "uncaught-exchange@example.com",
    async () => new Response("error code: 1101", { status: 500 }),
  );
  expectBackOnSignInPage(response, "uncaught-exchange@example.com");
  expect(warn).toHaveBeenCalledWith({
    event: "issuer.platform-failure-sign-in",
    name: "code-exchange",
    reason: "token-endpoint",
    message: "Iterate token exchange failed (500). Try again.",
    waitedMs: expect.any(Number),
    userId: (await controlPlane().ensureUser("uncaught-exchange@example.com")).id,
  });
});

test("the token endpoint rides out a deploy's reset of the person's Durable Object during a code exchange: it reads the account again, once", async () => {
  const user = await controlPlane().ensureUser("deploy-reset-exchange@example.com");
  const client = await helpers().createClient({
    clientName: "Deploy reset",
    redirectUris: ["https://client.test/callback"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  const exchange = async (resets: number) => {
    const { query, verifier } = await authorizationRequest(client.clientId, [`${ORIGIN}/api`]);
    const { redirectTo } = await helpers().completeAuthorization({
      request: await helpers().parseAuthRequest(new Request(`${ORIGIN}/oauth2/auth?${query}`)),
      userId: user.id,
      scope: ["iterate"],
      metadata: {},
      revokeExistingGrants: false,
      props: {
        kind: "app",
        userId: user.id,
        email: user.email,
        projects: null,
        deadline: Date.now() + 30 * 24 * 3600_000,
      },
    });
    // What a deploy does to the account read: the person's Durable Object is reset for its new code
    // and workerd stamps the cut call retryable.
    let left = resets;
    const contexts = {
      getByName: (name: string) =>
        left-- > 0
          ? {
              invoke: () =>
                Promise.reject(
                  Object.assign(new Error("Durable Object reset because its code was updated."), {
                    retryable: true,
                    durableObjectReset: true,
                  }),
                ),
            }
          : env.ITERATE_CONTEXT.getByName(name),
    } as unknown as typeof env.ITERATE_CONTEXT;
    const request = new Request(`${ORIGIN}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code")!,
        client_id: client.clientId,
        redirect_uri: "https://client.test/callback",
        code_verifier: verifier,
      }),
    });
    return authorizationServerFetch(
      { ...env, ITERATE_CONTEXT: contexts },
      platformAddressesOf(env, request),
      request,
      createExecutionContext(),
    );
  };
  const warn = vi.spyOn(console, "warn");
  const healed = await exchange(1);
  expect(healed, await healed.clone().text()).toMatchObject({ status: 200 });
  // a deploy's reset is expected, never a platform failure the prd fault alarm counts
  expect(warn).toHaveBeenCalledExactlyOnceWith({
    event: "oauth.deploy-reset-account-state-retry",
    name: "account-state",
    userId: user.id,
    message: "Error: Durable Object reset because its code was updated.",
  });
  // bounded: a second reset in a row fails the exchange, which the sign-in answers as above
  await expect(exchange(2)).rejects.toThrow(/Durable Object reset because its code was updated/);
});

/** A password sign-in's POST /login, its token endpoint answered by `tokenEndpoint`. */
async function signInWhile(email: string, tokenEndpoint: () => Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error(`Unexpected external fetch: ${url}`);
    if (url.pathname === "/oauth2/token") return tokenEndpoint();
    return exports.default.fetch(request);
  });
  return exports.default.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ email, password: loginPassword(), next: "/login" }),
    }),
  );
}

/** The sign-in page the person is sent back to, with the platform failure's message. */
function expectBackOnSignInPage(response: Response, email: string) {
  expect(response).toMatchObject({ status: 303 });
  // no issuer session: only the pending code's cookie, dropped
  expect(response.headers.getSetCookie()).toEqual([clearLoginCookie]);
  const back = new URL(response.headers.get("location")!, ORIGIN);
  expect(back).toMatchObject({ pathname: "/login" });
  expect(Object.fromEntries(back.searchParams)).toEqual({
    next: "/login",
    error: "Sign-in failed on our side. Try again.",
    email,
    method: "password",
  });
}
