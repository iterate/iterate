// The /api/integrations/* HTTP surface, mounted under the Start catch-all
// route (src/routes/api.$.ts). Everything runs in the one OS worker, so itx
// effects call the session RpcTargets in-process (first-party authority, the
// same lane worker.ts uses for project ingress) — no loopback HTTP round trip
// to this deployment's own /api.
import { parseOAuthStateUnverified } from "./oauth-state.ts";
import { trustedInternalAuthContext } from "~/auth.ts";
import { ProjectCollectionRpcTarget } from "~/rpc-targets.ts";
import type { Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";

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
