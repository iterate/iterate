// The /api/integrations/* HTTP surface, mounted under the Start catch-all
// route (src/routes/api.$.ts) in the app worker.
//
// Resurrected from the pre-migration integration-api.ts (git history). The app
// worker has no itx bindings, so every itx effect goes through a
// one-shot pipelined capnweb HTTP batch against this deployment's own
// /api surface using the admin API secret — the same request-scoped
// pattern the inbound MCP exec_js tool uses.

// oxlint-disable-next-line iterate/no-capnweb-http-batch -- integration callbacks/webhooks are one-shot request-scoped calls: a single pipelined batch (authenticate -> route/complete) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import type { UnauthenticatedOs } from "../../types.ts";
import { parseOAuthStateUnverified } from "./oauth-state.ts";
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
  // The Slack webhook lanes (/api/integrations/slack/webhook,
  // .../interactivity-webhook) are NOT here: they are served by the api
  // worker (src/domains/integrations/slack-webhook-api.ts), which has the
  // engine bindings and routes events directly — no RPC round trip.
  return null;
}

/** One-shot pipelined capnweb batch against this deployment's own itx surface. */
function engineBatchSession(context: RequestContext) {
  const baseUrl = (context.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is not configured");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per integration request; no socket lifecycle to manage.
  return newHttpBatchRpcSession<UnauthenticatedOs>(
    new Request(`${baseUrl}/api`, { method: "POST" }),
  );
}

function requireAdminSecret(context: RequestContext): string {
  const secret = context.config.adminApiSecret?.exposeSecret();
  if (!secret) throw new Error("Admin API secret is not configured.");
  return secret;
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

  const session = engineBatchSession(input.context);
  const root = session.authenticate({
    type: "admin-secret",
    secret: requireAdminSecret(input.context),
  });
  const project = root.projects.get(unverified.projectId);
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
