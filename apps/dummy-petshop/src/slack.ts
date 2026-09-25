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
 * Slack answers errors as HTTP 200 `{ ok: false, error }`, and so does this.
 * Codes and tokens are sealed blobs (seal.ts).
 */
import { hmacSha256Hex, nowSeconds, pkceS256, seal, unseal } from "./seal.ts";
import type { IntegrationFakeDeps } from "./state.ts";

interface SlackCodePayload {
  t: "slack-code";
  jti: string;
  clientId: string;
  redirectUri: string;
  team: { id: string; name: string };
  scope: string;
  codeChallenge: string;
  exp: number;
}

interface SlackBotTokenPayload {
  t: "slack-bot";
  jti: string;
  team: { id: string; name: string };
  scope: string;
}

const slackError = (error: string) => Response.json({ ok: false, error });

/** Slack's paths on this origin, or null when the request is not one of them. */
export async function handleSlackRequest(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /oauth/v2/authorize") {
    const query = Object.fromEntries(url.searchParams);
    if (!(await deps.state.getState()).clients[query.client_id || ""])
      return Response.json({ error: "invalid_client_id" }, { status: 400 });
    if (!URL.canParse(query.redirect_uri || ""))
      return Response.json({ error: "bad_redirect_uri" }, { status: 400 });
    const teamId = query.team || `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const code: SlackCodePayload = {
      t: "slack-code",
      jti: crypto.randomUUID(),
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      team: { id: teamId, name: query.team_name || `Pet Shop ${teamId}` },
      scope: query.scope || "chat:write",
      codeChallenge: query.code_challenge || "",
      exp: nowSeconds() + 120,
    };
    const target = new URL(code.redirectUri);
    target.searchParams.set("code", await seal(code, deps.sealKey));
    target.searchParams.set("state", query.state || "");
    return Response.redirect(target.toString(), 302);
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
    const client = (await deps.state.getState()).clients[args.client_id || ""];
    if (!client || client.public || client.clientSecret !== args.client_secret)
      return slackError("invalid_client_id");
    const code = await unseal<SlackCodePayload>(args.code || "", deps.sealKey);
    if (code?.t !== "slack-code" || code.clientId !== args.client_id || code.exp <= nowSeconds())
      return slackError("invalid_code");
    if (args.redirect_uri && args.redirect_uri !== code.redirectUri)
      return slackError("bad_redirect_uri");
    if (code.codeChallenge && (await pkceS256(args.code_verifier || "")) !== code.codeChallenge)
      return slackError("invalid_code_verifier");
    if (!(await deps.state.consumeAuthorizationCode(code.jti))) return slackError("invalid_code");
    const token: SlackBotTokenPayload = {
      t: "slack-bot",
      jti: crypto.randomUUID(),
      team: code.team,
      scope: code.scope,
    };
    return Response.json({
      ok: true,
      access_token: await seal(token, deps.sealKey),
      token_type: "bot",
      scope: code.scope,
      team: code.team,
    });
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const token = await unseal<SlackBotTokenPayload>(bearer || args.token || "", deps.sealKey);
  const live =
    token?.t === "slack-bot" &&
    !(await deps.state.getState()).revokedRefreshTokenIds.includes(token.jti);
  if (!live) return slackError("invalid_auth");
  if (method === "auth.test")
    return Response.json(
      {
        ok: true,
        url: `https://${token.team.id.toLowerCase()}.slack.com/`,
        team: token.team.name,
        team_id: token.team.id,
      },
      { headers: { "x-oauth-scopes": token.scope } },
    );
  if (method === "auth.revoke") {
    await deps.state.revokeToken(token.jti);
    return Response.json({ ok: true, revoked: true });
  }
  if (!args.channel) return slackError("channel_not_found");
  const message = { channel: args.channel, text: args.text || "", ts: `${Date.now() / 1000}` };
  await deps.state.recordSlackMessage(token.team.id, message);
  return Response.json({ ok: true, channel: message.channel, ts: message.ts, message });
}

/**
 * The Slack fake's test controls (worker.ts has already checked their secret),
 * or null: `GET /__backdoor/slack/messages?team=<id>` lists what was posted;
 * `POST /__backdoor/slack/fire-webhook { url, signingSecret, event, badSignature? }`
 * POSTs `event` to `url` signed the way Slack signs
 * (`x-slack-signature: v0=<hex HMAC of "v0:<ts>:<body>">`) and answers the
 * receiver's status and body.
 */
export async function handleSlackTestControls(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /__backdoor/slack/messages") {
    const team = url.searchParams.get("team") || "";
    return Response.json({ messages: (await deps.state.getState()).slackMessages?.[team] || [] });
  }
  if (key !== "POST /__backdoor/slack/fire-webhook") return null;
  const input: { url: string; signingSecret: string; event: unknown; badSignature?: boolean } =
    await request.json();
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
