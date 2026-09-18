import { startAppSession } from "iterate/next/app-server";
import { sameOriginPath } from "iterate/next/lib";
import type { Env } from "./control-plane.ts";
import type { User } from "./directory.ts";
import { oauthAddresses, oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";

/** Verified Google login and explicitly enabled test/administrator login call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. `picture` is the
 * identity provider's picture of the person, when it gave one (Google does). */
export async function startIssuerSession(env: Env, user: User, next: string, picture?: string) {
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
      picture,
      projects: null,
      deadline: Date.now() + 30 * 24 * 3600_000,
    } satisfies GrantProps,
  });
  const callback = new URL(approved.redirectTo).searchParams;
  const result = await flow.session.complete({
    state: callback.get("state") || "",
    issuer: callback.get("iss") || "",
    code: callback.get("code") || "",
    error: callback.get("error") || "",
  });
  if (result.error) throw new Error(result.error);
  return { setCookie: flow.setCookie, location: result.next! };
}
