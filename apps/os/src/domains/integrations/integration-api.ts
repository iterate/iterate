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
  fetchLikeFromFetcher,
  McpOAuthError,
  readMcpOAuthProjectId,
} from "~/domains/itx/mcp-oauth.ts";
import { projectEgressFetcher } from "~/domains/projects/utils.ts";

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

  // GitHub connects via App installation: the callback carries `installation_id`
  // (+ setup_action), not an OAuth `code`. slack/google carry a code.
  const code = url.searchParams.get("code") ?? undefined;
  const installationId = url.searchParams.get("installation_id") ?? undefined;
  if (input.provider === "github") {
    if (!installationId) return redirectWithError(callbackUrl, "github_missing_installation_id");
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
    return redirectWithError(result.callbackUrl ?? callbackUrl, result.error);
  }
  return redirectResponse(result.callbackUrl ?? callbackUrl ?? "/");
}

/**
 * The outbound MCP-OAuth callback — the other half of itx.mcp.beginOAuth. The
 * provider redirects here after the user signs in; we redeem the code, store
 * the token write-only in the project's Secret DO (material + egress + refresh
 * in one update, so it is born pinned and usable), and — for an agent-minted
 * link — message the agent so it can continue. The state is ENCRYPTED (it
 * carries a client secret + PKCE verifier), so unlike the integrations
 * callbacks there is no unsigned projectId to read: it is decrypted here with
 * SECRET_ENCRYPTION_KEY. Completing the flow OVERWRITES the secret at the
 * state's path, so — like collectFromUser's page — the browser session must
 * belong to a member of the project: a leaked link cannot let a stranger
 * clobber a project secret with their own token.
 */
async function handleMcpOAuthCallback(input: {
  auth: Principal | null | undefined;
  context: RequestContext;
  request: Request;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return resultPage(
      "Sign-in was cancelled",
      `The authorization server reported: ${error}. You can close this tab.`,
      400,
    );
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    return resultPage(
      "This link is incomplete",
      "It is missing the authorization code or state. Ask the agent for a fresh link.",
      400,
    );
  }
  const iss = url.searchParams.get("iss") ?? undefined;
  try {
    const projectId = await readMcpOAuthProjectId(state, itxEnv.SECRET_ENCRYPTION_KEY);
    // The completing browser must be a signed-in member of the project — the
    // token is about to overwrite a project secret. assertCanAccessProject
    // throws for a non-member or a non-user session.
    if (input.auth?.type !== "user") {
      return resultPage(
        "Please sign in first",
        "Open this link in a browser signed in to Iterate, then try again.",
        403,
      );
    }
    try {
      itxAuthFromPrincipal(input.context.config, input.auth).assertCanAccessProject(projectId);
    } catch {
      return resultPage(
        "Not authorized",
        "You are not a member of this project, so this connection cannot be stored for it.",
        403,
      );
    }
    const egress = projectEgressFetcher(input.context.executionCtx.exports, projectId);
    const result = await completeMcpOAuth({
      state,
      code,
      ...(iss ? { iss } : {}),
      encryptionKey: itxEnv.SECRET_ENCRYPTION_KEY,
      fetchFn: fetchLikeFromFetcher(egress),
    });
    await itxEnv.SECRET.getByName(
      DurableObjectNameCodec.stringify({ projectId, path: result.path }),
    ).update(result.secret);

    // Best-effort notify: the token is stored regardless, so a notify failure
    // must not read as total failure (the user would redo it; the agent waits).
    let notifyFailed = false;
    if (result.notify) {
      try {
        const project = await new ProjectCollectionRpcTarget({
          auth: trustedInternalAuthContext(),
          config: input.context.config,
          ctx: input.context.executionCtx,
        }).get(projectId);
        await project.agents
          .get(result.notify)
          .message(
            `The OAuth connection to ${result.mcpUrl} is done. The token is stored write-only at ` +
              `"${result.path}" (pinned to ${result.egressOrigins.join(", ")}). Connect with ` +
              `itx.mcp.connect({ url: "${result.mcpUrl}", headers: { authorization: ` +
              `'Bearer getSecret({ path: "${result.path}", field: "accessToken" })' } }).`,
          );
      } catch (cause) {
        console.error("mcp-oauth: failed to notify", result.notify, cause);
        notifyFailed = true;
      }
    }
    return resultPage(
      "Connected",
      notifyFailed
        ? `The connection is stored, but the agent could not be notified. Tell it the token at ${result.path} is ready.`
        : "You can close this tab and return to the agent.",
      200,
    );
  } catch (cause) {
    const message =
      cause instanceof McpOAuthError
        ? cause.message
        : "Something went wrong completing the connection.";
    if (!(cause instanceof McpOAuthError)) console.error("mcp-oauth: callback failed", cause);
    return resultPage("Could not complete sign-in", message, 400);
  }
}

/** A tiny self-contained result page for the MCP-OAuth callback (no chrome, no
 * route): the user lands here from an external provider, so it must render on
 * its own. Escapes its text — the message can carry a server-supplied URL. */
function resultPage(title: string, body: string, status: number): Response {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
main{max-width:26rem;padding:2.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;line-height:1.5}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectWithError(callbackUrl: string | null, error: string) {
  if (!callbackUrl) return redirectResponse(`/?error=${encodeURIComponent(error)}`);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return redirectResponse(url.toString());
}

// Response.redirect rejects relative URLs, and the app's own origin is not
// knowable here without config.baseUrl — a plain 302 Location header is.
function redirectResponse(location: string) {
  return new Response(null, { headers: { location }, status: 302 });
}
