import { startAppSession } from "iterate/next/app-server";
import { sameOriginPath } from "iterate/next/lib";
import type { Env } from "./control-plane.ts";
import type { User } from "./directory.ts";
import { oauthAddresses, oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";

/** Verified Google login and explicitly enabled test/administrator login call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does). */
export async function startIssuerSession(
  env: Env,
  user: User,
  next: string,
  /** what the identity provider said about the person (Google's profile); an email sign-in has none */
  profile: { picture?: string; name?: string } = {},
) {
  const { issuer, api } = oauthAddresses(env);
  // The issuer's own session holds every scope: it is the person at the issuer, and the consent
  // page creates organizations and projects through it.
  const flow = await startAppSession(
    env.BROWSER_SESSION,
    {
      origin: issuer,
      issuer,
      resource: api,
      scopes: ["iterate", "account", "organizations:write"],
    },
    sameOriginPath(next, issuer),
  );
  const helpers = oauthHelpers(env);
  const request = await parseAuthorization(env, new Request(flow.location));
  const approved = await helpers.completeAuthorization({
    request,
    userId: user.id,
    scope: request.scope,
    metadata: { clientName: "iterate" },
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
