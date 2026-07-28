// The /api/integrations/* HTTP surface, mounted under the Start catch-all
// route (src/routes/api.$.ts). Everything runs in the one OS worker, so itx
// effects call the session RpcTargets in-process (first-party authority, the
// same lane worker.ts uses for project ingress) — no loopback HTTP round trip
// to this deployment's own /api.
import { parseOAuthStateUnverified } from "./oauth-state.ts";
import { itxAuthFromPrincipal, trustedInternalAuthContext } from "~/auth.ts";
import { ProjectCollectionRpcTarget } from "~/rpc-targets.ts";
import type { Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";
import { itxEnv } from "~/env.ts";
import { DurableObjectNameCodec } from "~/domains/durable-object-names.ts";
import {
  completeMcpOAuth,
  decodeMcpOAuthState,
  fetchLikeFromFetcher,
  McpOAuthError,
} from "~/domains/itx/mcp-oauth.ts";
import { projectEgressFetcher } from "~/domains/projects/utils.ts";
import { readProjectById } from "~/project-directory.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";

export async function handleIntegrationApiRequest(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname === "/api/integrations/slack/callback") {
    return await handleOAuthCallback({ ...input, provider: "slack" });
  }
  if (url.pathname === "/api/integrations/google/callback") {
    return await handleOAuthCallback({ ...input, provider: "google" });
  }
  if (url.pathname === "/api/integrations/github/callback") {
    return await handleOAuthCallback({ ...input, provider: "github" });
  }
  if (url.pathname === "/api/mcp-oauth/callback") {
    return await handleMcpOAuthCallback(input);
  }
  // The webhook lanes (/api/integrations/<slug>/webhook, + slack's
  // interactivity lane) are NOT here: they are served by the api worker
  // (src/domains/integrations/integration-webhook-api.ts), which has the engine
  // bindings and routes events directly — no RPC round trip.
  return null;
}

async function handleOAuthCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  provider: "github" | "google" | "slack";
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });
  const unverified = parseOAuthStateUnverified(state);
  if (!unverified || unverified.provider !== input.provider) {
    return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
  }
  const callbackUrl = unverified.callbackUrl ?? null;
  if (error) return redirectWithError(callbackUrl, `${input.provider}_oauth_denied`);

  // GitHub is a two-stage callback. The setup URL first supplies an untrusted
  // installation_id; completeConnect redirects through GitHub user OAuth, and
  // the second callback supplies the code that proves access to that id.
  const code = url.searchParams.get("code") ?? undefined;
  const installationId = url.searchParams.get("installation_id") ?? undefined;
  if (input.provider === "github") {
    if (!installationId && !code) {
      return redirectWithError(callbackUrl, "github_missing_installation_id");
    }
  } else if (!code) {
    return redirectWithError(callbackUrl, `${input.provider}_oauth_missing_code`);
  }

  // The signed-state userId binding: the user completing the flow must be the
  // user who started it. The state signature itself is verified itx-side;
  // here we only need who the browser session is.
  const userId = input.auth?.type === "user" ? input.auth.userId : null;
  if (userId === null) return new Response("OAuth callback user mismatch.", { status: 403 });

  // First-party authority: the caller's session was checked above, and the
  // state signature is verified itx-side; completing the connect is this
  // worker's own doing, not something the browser is authorized for.
  const project = await new ProjectCollectionRpcTarget({
    auth: trustedInternalAuthContext(),
    config: input.context.config,
    ctx: input.context.executionCtx,
  }).get(unverified.projectId);
  const result = await project.integrations.completeConnect({
    code,
    installationId,
    provider: input.provider,
    state,
    userId,
  });

  if (!result.ok) {
    if (result.error.endsWith("_user_mismatch")) {
      return new Response("OAuth callback user mismatch.", { status: 403 });
    }
    if (result.error.endsWith("_invalid_state")) {
      return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
    }
    if (result.error === "github_installation_already_claimed" && "githubStealState" in result) {
      return redirectWithGithubSteal(result.callbackUrl ?? callbackUrl, result.githubStealState);
    }
    return redirectWithError(result.callbackUrl ?? callbackUrl, result.error);
  }
  return redirectResponse(result.callbackUrl ?? callbackUrl ?? "/");
}

/**
 * The outbound MCP-OAuth callback — the other half of itx.mcp.beginOAuth. The
 * provider redirects here after the user signs in; we redeem the code, store the
 * token write-only in the project's Secret DO (material + egress + refresh in one
 * update, so it is born pinned and usable), message the agent, and redirect back
 * into the app (the agent's message is the real "next step"). The state is
 * ENCRYPTED (it carries the PKCE verifier — the only thing protecting a public
 * client's code), so it is decoded ONCE here: we read `projectId` to route, gate
 * on membership, then reuse the decoded state for the exchange. Completing the
 * flow OVERWRITES the secret at the state's path, so — like collectFromUser's
 * page — the browser session must belong to a member of the project: a leaked
 * link cannot let a stranger clobber a project secret with their own token.
 */
async function handleMcpOAuthCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const providerError = url.searchParams.get("error");
  if (providerError) return redirectWithError(null, `mcp_oauth_${providerError}`);
  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!stateParam || !code) return redirectWithError(null, "mcp_oauth_incomplete_callback");
  const iss = url.searchParams.get("iss") ?? undefined;
  try {
    const state = await decodeMcpOAuthState(stateParam, itxEnv.SECRET_ENCRYPTION_KEY);
    // The completing browser must be a signed-in member of the project — the
    // token is about to overwrite a project secret.
    if (input.auth?.type !== "user") return redirectWithError(null, "mcp_oauth_sign_in_required");
    try {
      itxAuthFromPrincipal(input.auth, {
        allowDirectoryFallback: input.context.operatorSession == null,
      }).assertCanAccessProject(state.projectId);
    } catch {
      return redirectWithError(null, "mcp_oauth_not_a_member");
    }
    const egress = projectEgressFetcher(input.context.executionCtx.exports, state.projectId, {
      kind: "scope",
      scopePath: "/",
    });
    const result = await completeMcpOAuth(state, {
      code,
      ...(iss ? { iss } : {}),
      fetchFn: fetchLikeFromFetcher(egress),
    });
    const secret = itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({ projectId: state.projectId, path: result.path }),
    );
    if ((await secret.describe()).created) await secret.update(result.secret);
    else await secret.create(result.secret);

    // Best-effort notify: the token is stored regardless, so a notify failure
    // must not read as total failure (the user would redo it; the agent waits).
    if (result.notify) {
      try {
        const project = await new ProjectCollectionRpcTarget({
          auth: trustedInternalAuthContext(),
          config: input.context.config,
          ctx: input.context.executionCtx,
        }).get(state.projectId);
        await project.agents
          .get(result.notify)
          .message(
            `The OAuth connection to ${result.mcpUrl} is done. The token is stored write-only at ` +
              `"${result.path}" (pinned to ${result.secret.egress.urls.join(", ")}). Connect with ` +
              `itx.mcp.connect({ url: "${result.mcpUrl}", headers: { authorization: ` +
              `'Bearer getSecret("${result.path}", { field: "accessToken" })' } }).`,
          );
      } catch (cause) {
        console.error("mcp-oauth: failed to notify", result.notify, cause);
      }
    }
    // Land the user back in the thread that started the flow — NOT "/", which for
    // a user still mid-onboarding resolves to the onboarding thread and loses
    // their place. `notify` is the initiating agent's stream path (agent scopes
    // only); fall back to "/" when there is no agent scope or the slug won't
    // resolve.
    let redirectTo = "/";
    if (result.notify?.startsWith("/agents/")) {
      const record = await readProjectById(itxEnv.PROJECT_DIRECTORY, state.projectId).catch(
        () => null,
      );
      if (record?.slug) {
        redirectTo = `/projects/${encodeURIComponent(record.slug)}/agents/streams/${streamPathToSplat(result.notify)}`;
      }
    }
    return redirectResponse(redirectTo);
  } catch (cause) {
    if (!(cause instanceof McpOAuthError)) console.error("mcp-oauth: callback failed", cause);
    return redirectWithError(null, "mcp_oauth_failed");
  }
}

function redirectWithError(callbackUrl: string | null, error: string) {
  if (!callbackUrl) return redirectResponse(`/?error=${encodeURIComponent(error)}`);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return redirectResponse(url.toString());
}

function redirectWithGithubSteal(callbackUrl: string | null, state: string) {
  const location = callbackUrl || "/";
  const url = new URL(location, "https://os.iterate.com");
  url.searchParams.set("error", "github_installation_already_claimed");
  url.searchParams.set("githubSteal", state);
  return redirectResponse(callbackUrl ? url.toString() : `${url.pathname}${url.search}`);
}

// Response.redirect rejects relative URLs, and the app's own origin is not
// knowable here without config.baseUrl — a plain 302 Location header is.
function redirectResponse(location: string) {
  return new Response(null, { headers: { location }, status: 302 });
}
