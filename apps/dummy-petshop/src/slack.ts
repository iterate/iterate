/**
 * A Slack-shaped fake, served on the pet shop's origin at Slack's own paths, so
 * an integration pointed at this origin speaks to it exactly as to
 * https://slack.com:
 *
 *   GET  /oauth/v2/authorize   consent at once: redirects with a code for the workspace
 *                              `&team=<id>` (`&team_name`), minted when absent
 *   POST /api/oauth.v2.access  the code → a bot token; the client by `client_id` and
 *                              `client_secret` in the form, PKCE when the code carried a challenge
 *   POST /api/auth.test        whose token this is (+ `x-oauth-scopes`)
 *   POST /api/chat.postMessage records `{ channel, text }` for the workspace
 *   POST /api/auth.revoke      the token stops working
 *
 * Slack answers errors as HTTP 200 `{ ok: false, error }`, and so does this. The OAuth steps are
 * the fakes' one authorization server (authorization-server.ts); a bot token is its refresh token,
 * which never expires.
 */
import { z } from "zod";
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import { hmacSha256Hex, nowSeconds } from "./seal.ts";
import type { ShopDeps } from "./state.ts";

const slackError = (error: string) => Response.json({ ok: false, error });

const FireWebhook = z.object({
  url: z.url(),
  signingSecret: z.string(),
  event: z.unknown(),
  badSignature: z.boolean().optional(),
});

interface SlackGrant {
  team: { id: string; name: string };
  scope: string;
}

/** Slack's paths on this origin, or null when the request is not one of them. */
export async function handleSlackRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const slack = fakeAuthorizationServer<SlackGrant>(deps, "slack");
  if (key === "GET /oauth/v2/authorize") {
    const query = Object.fromEntries(url.searchParams);
    const refusal = await slack.authorizeRefusal(query.client_id || "", query.redirect_uri || "");
    if (refusal) return refusal;
    const teamId = query.team || `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const code = await slack.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      grant: {
        team: { id: teamId, name: query.team_name || `Pet Shop ${teamId}` },
        scope: query.scope || "chat:write",
      },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  const method = /^POST \/api\/(oauth\.v2\.access|auth\.test|auth\.revoke|chat\.postMessage)$/.exec(
    key,
  )?.[1];
  if (!method) return null;
  // Slack's Web API takes a form, and chat.postMessage a JSON body too; the fields read here are
  // strings in either
  const args = (
    (request.headers.get("content-type") || "").includes("application/json")
      ? await request.json().catch(() => ({}))
      : Object.fromEntries(new URLSearchParams(await request.text()))
  ) as Record<string, string | undefined>;
  if (method === "oauth.v2.access") {
    const client = await tokenClient(deps, request, args);
    if (!client) return slackError("invalid_client_id");
    const redeemed = await slack.redeemCode(args.code || "", {
      ...client,
      redirectUri: args.redirect_uri,
      codeVerifier: args.code_verifier,
    });
    if ("refused" in redeemed)
      return slackError(
        redeemed.refused === "redirect_uri mismatch"
          ? "bad_redirect_uri"
          : redeemed.refused === "PKCE code_verifier mismatch"
            ? "invalid_code_verifier"
            : "invalid_code",
      );
    const { team, scope } = redeemed.grant;
    return Response.json({
      ok: true,
      access_token: await slack.refreshToken(undefined, redeemed.grant),
      token_type: "bot",
      scope,
      team,
    });
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const token = bearer || args.token || "";
  const bot = await slack.openRefreshToken(token);
  if (!bot) return slackError("invalid_auth");
  const { team, scope } = bot.grant;
  if (method === "auth.test")
    return Response.json(
      {
        ok: true,
        url: `https://${team.id.toLowerCase()}.slack.com/`,
        team: team.name,
        team_id: team.id,
      },
      { headers: { "x-oauth-scopes": scope } },
    );
  if (method === "auth.revoke") {
    await slack.revokeRefreshToken(token);
    return Response.json({ ok: true, revoked: true });
  }
  if (!args.channel) return slackError("channel_not_found");
  const message = { channel: args.channel, text: args.text || "", ts: `${Date.now() / 1000}` };
  await deps.state.recordSlackMessage(team.id, message);
  return Response.json({ ok: true, channel: message.channel, ts: message.ts, message });
}

/**
 * The Slack fake's test controls, or null: `GET /__backdoor/slack/messages?team=<id>` lists what
 * was posted; `POST /__backdoor/slack/fire-webhook { url, signingSecret, event, badSignature? }`
 * POSTs `event` to `url` signed the way Slack signs
 * (`x-slack-signature: v0=<hex HMAC of "v0:<ts>:<body>">`) and answers the receiver's status and
 * body.
 */
export async function handleSlackTestControls(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /__backdoor/slack/messages") {
    const team = url.searchParams.get("team") || "";
    return Response.json({ messages: (await deps.state.getState()).slackMessages?.[team] || [] });
  }
  if (key !== "POST /__backdoor/slack/fire-webhook") return null;
  const parsed = FireWebhook.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "invalid_request", error_description: parsed.error.message },
      { status: 400 },
    );
  const input = parsed.data;
  const body = JSON.stringify(input.event);
  const timestamp = String(nowSeconds());
  const secret = input.badSignature ? "definitely-not-the-signing-secret" : input.signingSecret;
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const answer = await response
      .clone()
      .json()
      .catch(() => response.text());
    return Response.json({ status: response.status, body: answer });
  } catch (error) {
    return Response.json({ status: 0, body: null, error: String(error) });
  }
}
