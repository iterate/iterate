import { startAppSession } from "iterate/app-server";
import { reportIssue, sameOriginPath } from "iterate/lib";
import { OAuthScope } from "iterate/oauth-scopes";
import { clientDisplay } from "./client-display.ts";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";
import type { Env } from "./env.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";
import { isRetryableTransportError } from "./retryable-error.ts";
import { watchSignInStep } from "./sign-in-watch.ts";
import { redeemTestLink } from "./test-link.ts";

/** What the person reads when the platform failed their sign-in, on the sign-in page. */
const PLATFORM_FAILURE_MESSAGE = "Sign-in failed on our side. Try again.";

/** Verified Google login and explicitly enabled test/administrator login call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does).
 *
 * `{ error }` is the one modelled failure: the code exchange against the issuer's own public
 * `/oauth2/token` failed. A code is spent by the exchange that reached the token endpoint, so the
 * exchange is never retried here; every caller sends the person back to the sign-in page with the
 * error, and a fresh sign-in is the recovery. How the failure is logged is the split:
 *  - a PLATFORM FAILURE (`codeExchangeFailure`) — the exchange timed out (the browser session
 *    bounds it at 10 s), its call was cut at the transport (a Durable Object reset, a lost
 *    connection), or the token endpoint answered a status instead of a token (a 500 when its own
 *    grant checks failed) — logs a warn `issuer.platform-failure-sign-in` with its `reason`, which
 *    the prd fault alarm counts. It names the person, so a timeout joins the line the token
 *    request logged about the hop it was still waiting on (`oauth.step-slow`, oauth.ts);
 *  - anything else is a defect of ours, reported at error level (`issuer.code-exchange-failed`),
 *    which the prd fault alarm pages on. The person still lands on the sign-in page, not a 1101.
 * The earlier steps' failures throw. */
export async function startIssuerSession(
  env: Env,
  /** the sign-in request — its origin is the issuer on a deployment that named no `urls.os` */
  request: Request,
  user: UserRecord,
  next: string,
  /** what the grant carries beyond the person: what the identity provider said about them
   *  (Google's profile; an email sign-in has none), and a test link's pre-approved clients */
  extras: Pick<GrantProps, "picture" | "name" | "testLink"> = {},
): Promise<{ setCookie: string; location: string } | { error: string }> {
  const addresses = platformAddressesOf(env, request);
  const { platformOrigin, api } = addresses;
  // The issuer's own session holds every scope but `admin`: it is the person at the issuer, and the
  // consent page creates organizations and projects through it. `admin` is an app's to ask for
  // (the admin app's); the issuer's session reaches every project host under paths routing, where
  // an admin's would count as a member of every project.
  const flow = await watchSignInStep(
    "session-begin",
    startAppSession(
      env.BROWSER_SESSION,
      {
        origin: platformOrigin,
        client: { name: "iterate", logoUri: `${platformOrigin}/iterate-logo.svg` },
        issuer: platformOrigin,
        resource: api,
        scopes: OAuthScope.options.filter((scope) => scope !== "admin"),
      },
      sameOriginPath(next, platformOrigin),
    ),
  );
  const helpers = oauthHelpers(env, addresses);
  const authorization = await watchSignInStep(
    "parse-authorization",
    parseAuthorization(env, new Request(flow.location)),
  );
  const approved = await watchSignInStep(
    "complete-authorization",
    helpers.completeAuthorization({
      request: authorization,
      userId: user.id,
      scope: authorization.scope,
      metadata: clientDisplay(
        { clientName: "iterate", logoUri: `${platformOrigin}/iterate-logo.svg` },
        authorization.clientId,
      ),
      revokeExistingGrants: false,
      props: {
        kind: "issuer",
        userId: user.id,
        email: user.email,
        picture: extras.picture,
        name: extras.name,
        testLink: extras.testLink,
        projects: null,
        deadline: Date.now() + 30 * 24 * 3600_000,
      } satisfies GrantProps,
    }),
  );
  const exchangeStarted = Date.now();
  const result = await watchSignInStep(
    "code-exchange",
    flow.session.complete(new URL(approved.redirectTo).search),
  ).catch((error: unknown) => {
    const reason = codeExchangeFailure(error);
    if (reason)
      console.warn({
        event: "issuer.platform-failure-sign-in",
        name: "code-exchange",
        reason,
        message: error instanceof Error ? error.message : String(error),
        waitedMs: Date.now() - exchangeStarted,
        userId: user.id,
      });
    else
      reportIssue("issuer.code-exchange-failed", error, {
        waitedMs: Date.now() - exchangeStarted,
        userId: user.id,
      });
    return null;
  });
  if (!result) return { error: PLATFORM_FAILURE_MESSAGE };
  if (result.error) throw new Error(result.error);
  return { setCookie: flow.setCookie, location: result.next! };
}

/** Why a code exchange failed on the platform's side, or null when it did not (a defect of ours).
 *  Read off what crosses the browser session's Durable Object RPC: workerd carries a DOMException
 *  as one, name and all, stamps a cut call `retryable`, and the session names the token endpoint's
 *  status in its own message (iterate/app-session.ts `#endOnDeadGrant`). */
function codeExchangeFailure(error: unknown): "timeout" | "transport" | "token-endpoint" | null {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (isRetryableTransportError(error)) return "transport";
  if (error instanceof Error && /^Iterate token exchange failed \(\d+\)/.test(error.message))
    return "token-endpoint";
  return null;
}

/** `GET /.auth/test-link?t=` (test-link.ts; routed by worker.ts on the platform origin): a
 *  preview's one-click sign-in. The pure decision refuses what is not this deployment's to honour;
 *  a good link finds or creates its test person, starts the issuer session exactly as a password
 *  sign-in does — stamped with the link's sibling app clients, which consent.ts then approves
 *  without the Allow page — and sends the browser to the link's `next`. The password-attempt
 *  counters are never touched: a shared link clicked many times locks nobody out. */
export async function testLinkResponse(request: Request, env: Env) {
  const config = appConfigOf(env);
  const decision = await redeemTestLink(new URL(request.url).searchParams.get("t"), {
    testLink: config.login.testLink,
    key: config.secrets.key.exposeSecret(),
    platformOrigin: platformAddressesOf(env, request).platformOrigin,
    now: Date.now(),
  });
  if (decision.status !== 302)
    return new Response(`${decision.message}\n`, {
      status: decision.status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const user = await watchSignInStep(
    "ensure-user",
    new ControlPlane(env).ensureUser(decision.email),
  );
  const session = await startIssuerSession(env, request, user, "/login", {
    testLink: { clients: decision.clients, project: decision.project },
  });
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if ("error" in session) {
    headers.set("location", `/login?${new URLSearchParams({ error: session.error })}`);
    return new Response(null, { status: 303, headers });
  }
  headers.set("location", decision.next);
  headers.set("set-cookie", session.setCookie);
  return new Response(null, { status: 302, headers });
}
