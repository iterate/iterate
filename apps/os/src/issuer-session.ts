import { waitUntil } from "cloudflare:workers";
import { startAppSession } from "iterate/app-server";
import { errorCode, reportIssue, sameOriginPath } from "iterate/lib";
import { OAuthScope } from "iterate/oauth-scopes";
import {
  failureKind,
  isPlatformFailureKind,
  type PlatformFailureKind,
} from "iterate/platform-retry";
import { clientDisplay } from "./client-display.ts";
import { platformAddressesOf } from "./app-config.ts";
import type { Env } from "./env.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import { accountStateOf, oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";
import { watchSignInStep } from "./sign-in-watch.ts";

/** What the person reads when the platform failed their sign-in, on the sign-in page. */
const PLATFORM_FAILURE_MESSAGE = "Sign-in failed on our side. Try again.";

/** Every sign-in ends in this tail: the password and code forms, a provider (identity.ts) and an
 * admin through another issuer (admin-sign-in.ts). Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does).
 *
 * `{ error }` is the one modelled failure: the code exchange against the issuer's own public
 * `/oauth2/token` failed. A code is spent by the exchange that reached the token endpoint, so the
 * exchange is never retried here; every caller sends the person back to the sign-in page with the
 * error, and a fresh sign-in is the recovery. How the failure is logged is the split:
 *  - a PLATFORM FAILURE (`codeExchangeFailure`) — the exchange timed out (the browser session
 *    bounds it at 10 s), its call failed on the platform's side (a deploy's reset, a lost
 *    connection, an overload: its `failureKind`), or the token endpoint answered a status instead
 *    of a token (a 500 when its own grant checks failed) — logs a warn
 *    `issuer.platform-failure-sign-in` with its `reason`, which the prd fault alarm counts. It
 *    names the person, so a timeout joins the line the token request logged about the hop it was
 *    still waiting on (`oauth.step-slow`, oauth.ts);
 *  - anything else is a defect of ours, reported at error level (`issuer.code-exchange-failed`),
 *    which the prd fault alarm pages on. The person still lands on the sign-in page, not a 1101.
 * The earlier steps' failures throw.
 *
 * The person's account starts here too, and the sign-in never waits for it (`startAccount`). */
export async function startIssuerSession(
  env: Env,
  /** the sign-in request — its origin is the issuer on a deployment that named no `urls.os` */
  request: Request,
  user: UserRecord,
  next: string,
  /** what the identity provider said about the person (Google's profile; an email sign-in has
   *  none), which the grant carries beside them */
  extras: Pick<GrantProps, "picture" | "name"> = {},
): Promise<{ setCookie: string; location: string } | { error: string }> {
  startAccount(env, user.id);
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

/** THE PERSON'S ACCOUNT, STARTED WHILE THE SIGN-IN FINISHES: one read of it in the background, so
 *  the first request after the sign-in (the consent page's admission) finds a new person's account
 *  running instead of waiting for Cloudflare to start it (oauth.ts `accountStateOf`). The read's
 *  platform failures are logged by `ownerContext` (session.ts), and a defect is reported. */
function startAccount(env: Env, userId: string): void {
  waitUntil(
    accountStateOf(env, userId).then(
      () => undefined,
      (error: unknown) => {
        if (errorCode(error) !== "UNAVAILABLE")
          reportIssue("issuer.account-start-failed", error, { userId });
      },
    ),
  );
}

/** Why a code exchange failed on the platform's side, or null when it did not (a defect of ours).
 *  Read off what crosses the browser session's Durable Object RPC: workerd carries a DOMException
 *  as one, name and all, stamps a platform failure with its kind (`failureKind`), and the session
 *  names the token endpoint's status in its own message (iterate/app-session.ts `#endOnDeadGrant`). */
function codeExchangeFailure(
  error: unknown,
): "timeout" | PlatformFailureKind | "token-endpoint" | null {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind)) return kind;
  if (error instanceof Error && /^Iterate token exchange failed \(\d+\)/.test(error.message))
    return "token-endpoint";
  return null;
}
