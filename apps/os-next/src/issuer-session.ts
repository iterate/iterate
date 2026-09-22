import { startAppSession } from "iterate/next/app-server";
import { sameOriginPath } from "iterate/next/lib";
import { clientDisplay } from "./client-display.ts";
import { platformAddressesOf } from "./app-config.ts";
import type { Env } from "./control-plane.ts";
import type { User } from "./directory.ts";
import { oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";

/** Verified Google login and explicitly enabled test/administrator login call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does). */
export async function startIssuerSession(
  env: Env,
  /** the sign-in request — its origin is the issuer on a deployment that named no `urls.os` */
  request: Request,
  user: User,
  next: string,
  /** what the identity provider said about the person (Google's profile); an email sign-in has none */
  profile: { picture?: string; name?: string } = {},
) {
  const addresses = platformAddressesOf(env, request);
  const { platformOrigin, api } = addresses;
  // The issuer's own session holds every scope: it is the person at the issuer, and the consent
  // page creates organizations and projects through it.
  const flow = await startAppSession(
    env.BROWSER_SESSION,
    {
      origin: platformOrigin,
      client: { name: "Iterate", logoUri: `${platformOrigin}/iterate-logo.svg` },
      issuer: platformOrigin,
      resource: api,
      scopes: ["iterate", "account", "organizations:write"],
    },
    sameOriginPath(next, platformOrigin),
  );
  const helpers = oauthHelpers(env, addresses);
  const authorization = await parseAuthorization(env, new Request(flow.location));
  const approved = await helpers.completeAuthorization({
    request: authorization,
    userId: user.id,
    scope: authorization.scope,
    metadata: clientDisplay(
      { clientName: "Iterate", logoUri: `${platformOrigin}/iterate-logo.svg` },
      authorization.clientId,
    ),
    revokeExistingGrants: false,
    props: {
      kind: "issuer",
      version: 2,
      userId: user.id,
      email: user.email,
      picture: profile.picture,
      name: profile.name,
      projects: null,
      deadline: Date.now() + 30 * 24 * 3600_000,
    } satisfies GrantProps,
  });
  const result = await flow.session.complete(new URL(approved.redirectTo).search);
  if (result.error) throw new Error(result.error);
  return { setCookie: flow.setCookie, location: result.next! };
}
