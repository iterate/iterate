import type { Env } from "./control-plane.ts";
import type { User } from "./directory.ts";
import { startAppSession } from "./client/app-auth.ts";
import { oauthAddresses, oauthHelpers, parseAuthorization, type GrantProps } from "./oauth.ts";
import { sameOriginPath } from "./lib.ts";

/** Only verified Google login and the privileged login fixture call this tail.
 * Its grant is the issuer's sole browser identity: ordinary storage, public token
 * exchange, admission, expiry and revocation. No separate identity cookie. */
export async function startIssuerSession(env: Env, user: User, next: string) {
  const { issuer, api } = oauthAddresses(env);
  const flow = await startAppSession(
    env.BROWSER_SESSION,
    { origin: issuer, issuer, resource: api, scopes: ["iterate", "account"] },
    sameOriginPath(next, issuer),
  );
  const helpers = oauthHelpers(env);
  const request = await parseAuthorization(env, new Request(flow.location));
  const approved = await helpers.completeAuthorization({
    request,
    userId: user.id,
    scope: request.scope,
    metadata: { clientName: "Iterate" },
    revokeExistingGrants: false,
    props: {
      kind: "issuer",
      version: 2,
      userId: user.id,
      email: user.email,
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
