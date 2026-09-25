// secret-oauth-callback.ts — the host half of a secret's OAuth (secret-oauth.ts is the pure half):
// the provider redirected the human to the platform's callback with a code and the platform-signed
// `state` naming the secret's context; this admits the human by the secret's owner and hands the code
// to the secret's facet, which runs the exchange. On an integration's callback
// (`/api/integrations/<provider>/callback`) the owner's facet then finishes the connection
// (src/integrations/verbs.ts). The human goes on to the attempt's `next` when it named one. Called by
// worker.ts.

import { verifyClaims } from "./caller.ts";
import { appConfigOf, sessionSigningSecretOf, type PlatformAddresses } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import {
  DurableObjectNameCodec,
  GLOBAL_PROJECT_ID,
  pathUnderOwner,
  resourceScope,
} from "./context/paths.ts";
import { ControlPlane, type Reach } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { authorizationForToken } from "./oauth.ts";
import { isSecretOAuthState, OAUTH_INTEGRATION_PROVIDERS } from "./secret-oauth.ts";

/** The human at a callback: their platform session — a browser cookie, or a bearer — or null. */
export async function callbackAuthorization(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return bearer
    ? authorizationForToken(env, bearer, addresses, "secret-oauth-callback")
    : browserAuthorization(env, request);
}

/** A secret's OWNER (context/paths.ts `resourceScope`), read off the secret's context (its Durable
 *  Object name, what the callback's claims carry): a project's id, or the user's / the
 *  organization's id whose own secret it is — the callback admits the human by it. `path` is the
 *  path the placeholder spells, `/secrets/<name>`, relative to the owner's root. */
function secretOwnerOf(context: string): {
  kind: "project" | "users" | "organizations";
  id: string;
  path: string;
} {
  const { projectId, path } = DurableObjectNameCodec.parse(context);
  const owner = resourceScope(projectId, path);
  if (owner.kind === "global") throw new Error("the global root owns no secrets");
  return { kind: owner.kind, id: owner.ownerId, path: pathUnderOwner(owner, path) };
}

/** WHO may complete a secret's OAuth: a session that reaches the secret's owner — for a project's
 *  secret, a session reaching that project; for a user's own, that user; for an organization's, a
 *  member; the admin reaches every one. A project-bound bearer reaches no user's or organization's
 *  own secrets; nothing but the admin reaches the global root's. */
async function reachesSecretOwner(
  controlPlane: ControlPlane,
  reach: Reach,
  owner: ReturnType<typeof secretOwnerOf>,
): Promise<boolean> {
  if (reach === "every") return true;
  if (owner.kind === "project") return controlPlane.reachesProject(reach, owner.id);
  // a grant bound to projects reaches those projects and nothing of the person's own (session.user)
  if (!("userId" in reach) || "projectIds" in reach) return false;
  if (owner.kind === "users") return reach.userId === owner.id;
  return controlPlane.reachesOrg(reach, owner.id);
}

/** A secret's OAuth callback: the provider redirected the human here with `code` and the
 *  platform-signed `state` (secret-oauth.ts) naming the secret's context and the nonce. WHO
 *  completes it is admitted the way a project host admits a visitor — the same platform session (a
 *  browser cookie, or a bearer) — and must reach the owner (`reachesSecretOwner`): a stranger who saw
 *  the authorize URL cannot plant their own provider account into someone else's secret. The
 *  secret's facet then exchanges the code; a failure is a plain-text 4xx with the reason, never a
 *  credential. */
export async function secretOAuthCallback(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
): Promise<Response> {
  const url = new URL(request.url);
  const answer = (status: number, text: string) =>
    new Response(`${text}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  const claims = await verifyClaims(
    url.searchParams.get("state") ?? "",
    await sessionSigningSecretOf(appConfigOf(env)),
  );
  if (!isSecretOAuthState(claims) || claims.exp <= Date.now())
    return answer(400, "This link is not one the platform issued, or it has expired.");
  const authorization = await callbackAuthorization(request, env, addresses);
  if (!authorization)
    return answer(
      401,
      "Sign in to iterate in this browser first, then open this link again — the tokens go into a project you must be a member of.",
    );
  let owner: ReturnType<typeof secretOwnerOf>;
  try {
    owner = secretOwnerOf(claims.context);
  } catch (error) {
    return answer(400, error instanceof Error ? error.message : String(error));
  }
  if (!(await reachesSecretOwner(new ControlPlane(env), authorization.reach, owner)))
    return answer(403, `Your session cannot access the secrets of ${owner.kind} ${owner.id}.`);
  const denied = url.searchParams.get("error");
  if (denied) return answer(400, `The provider declined: ${denied}`);
  const code = url.searchParams.get("code");
  if (!code) return answer(400, "The provider sent no authorization code.");
  const provider = OAUTH_INTEGRATION_PROVIDERS.find(
    (name) => url.pathname === `/api/integrations/${name}/callback`,
  );
  // On the secret's own context — `itx.secrets.completeOAuth` (built-ins.ts) runs the exchange in
  // the secret's facet and lands the facts, in the order every other write to that path takes; the
  // platform's own call, no principal.
  try {
    await env.ITERATE_CONTEXT.getByName(claims.context).invoke(
      ["itx", "builtins", "secrets", ["completeOAuth", owner.path, { code, nonce: claims.nonce }]],
      [],
      { principal: null },
    );
    if (provider && owner.kind !== "organizations")
      // The platform's own call on the owner's root: its facet (a project's `project`, a person's
      // `account`) finishes the connection its attempt names (integrations/verbs.ts).
      await env.ITERATE_CONTEXT.getByName(
        owner.kind === "project"
          ? DurableObjectNameCodec.stringify({ projectId: owner.id, path: "/" })
          : DurableObjectNameCodec.stringify({
              projectId: GLOBAL_PROJECT_ID,
              path: `/users/${owner.id}`,
            }),
      ).invoke(
        [
          "itx",
          "builtins",
          "facets",
          ["get", owner.kind === "project" ? "project" : "account"],
          [
            "finishIntegrationConnect",
            { provider, connection: owner.path.slice(`/secrets/${provider}-`.length) },
          ],
        ],
        [],
        { principal: null },
      );
  } catch (error) {
    return answer(
      400,
      `${provider ? `Connecting ${provider}` : `Storing the tokens for ${owner.path}`} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // `next` was checked against the platform's and the Dash's origins before it was signed.
  if (claims.next)
    return new Response(null, {
      status: 303,
      headers: { location: claims.next, "cache-control": "no-store" },
    });
  return answer(
    200,
    `Done: the secret ${owner.path} of ${owner.kind} ${owner.id} holds the tokens. You can close this tab.`,
  );
}
