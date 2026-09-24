import { startAppSession } from "iterate/app-server";
import { sameOriginPath } from "iterate/lib";
import { OAuthScope } from "iterate/oauth-scopes";
import { clientDisplay } from "./client-display.ts";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";
import type { Env } from "./env.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";
import { watchSignInStep } from "./sign-in-watch.ts";
import { redeemTestLink } from "./test-link.ts";

/** Verified Google login and explicitly enabled test/administrator login call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does). */
export async function startIssuerSession(
  env: Env,
  /** the sign-in request — its origin is the issuer on a deployment that named no `urls.os` */
  request: Request,
  user: UserRecord,
  next: string,
  /** what the grant carries beyond the person: what the identity provider said about them
   *  (Google's profile; an email sign-in has none), and a test link's pre-approved clients */
  extras: Pick<GrantProps, "picture" | "name" | "testLink"> = {},
) {
  const addresses = platformAddressesOf(env, request);
  const { platformOrigin, api } = addresses;
  // The issuer's own session holds every scope: it is the person at the issuer, and the consent
  // page creates organizations and projects through it.
  const flow = await watchSignInStep(
    "session-begin",
    startAppSession(
      env.BROWSER_SESSION,
      {
        origin: platformOrigin,
        client: { name: "iterate", logoUri: `${platformOrigin}/iterate-logo.svg` },
        issuer: platformOrigin,
        resource: api,
        scopes: [...OAuthScope.options],
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
  const result = await watchSignInStep(
    "code-exchange",
    flow.session.complete(new URL(approved.redirectTo).search),
  );
  if (result.error) throw new Error(result.error);
  return { setCookie: flow.setCookie, location: result.next! };
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
    new ControlPlane(env.CONTROL_PLANE).ensureUser(decision.email),
  );
  const { setCookie } = await startIssuerSession(env, request, user, "/login", {
    testLink: { clients: decision.clients, project: decision.project },
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: decision.next,
      "set-cookie": setCookie,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
