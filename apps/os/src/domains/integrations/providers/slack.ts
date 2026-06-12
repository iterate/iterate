// Slack as an IntegrationDefinition — the migration that proves the system:
// the previously bespoke Slack wiring (own webhook handlers, D1 connection
// claims, D1 bot-token secret) re-expressed as a provider file. Webhooks and
// interactivity capture to the global stream keyed by team; the OAuth
// callback is one ctx.connect; the bot token is a journaled Secret. Thread
// routing into agent streams is the slack-route processor
// (domains/slack/stream-processors/slack-route), hosted by the account's
// IntegrationDurableObject.

import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { constantTimeEqual, hmacSha256Hex } from "~/domains/integrations/providers/verify.ts";

export const SLACK_ACCESS_TOKEN_SECRET_NAME = "access-token";

export function slackTeamRoutingKey(teamId: string): string {
  return `team:${teamId}`;
}

/** The ACCOUNT for a workspace derives from its team id — deterministic, so
 * reconnecting the same workspace updates the same account while a second
 * workspace becomes a second account. Any number of Slacks just works. */
export function slackAccountForTeam(teamId: string): string {
  return teamId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/** Pure URL builder — the oRPC start-flow procedure uses it too. */
export function buildSlackAuthorizationUrl(input: {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(","));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export const slackIntegration: IntegrationDefinition = {
  slug: "slack",
  displayName: "Slack",
  instructions:
    "Slack for this project. itx.integrations.slack.<Web API method>(body) calls the Slack " +
    "Web API as the connected bot — e.g. itx.integrations.slack.chat.postMessage({ channel, text }). " +
    "Inbound Slack events land on this project's /integrations/slack/{account} stream and " +
    "route into per-thread agent streams.",

  async fetch(ctx) {
    const { pathname } = new URL(ctx.request.url);

    if (pathname === "/api/integrations/slack/webhook") {
      return await handleSlackWebhook(ctx, parseJsonObject);
    }
    if (pathname === "/api/integrations/slack/interactivity-webhook") {
      return await handleSlackWebhook(ctx, (body) => {
        const payload = new URLSearchParams(body).get("payload");
        return payload == null ? null : parseJsonObject(payload);
      });
    }
    if (pathname === "/api/integrations/slack/callback") {
      return await handleSlackOAuthCallback(ctx);
    }
    return null;
  },

  providedSecrets: [
    {
      name: SLACK_ACCESS_TOKEN_SECRET_NAME,
      description: "Slack bot token (xoxb) for the connected workspace.",
    },
  ],

  async createSdk(ctx) {
    // The Slack Web API is method-named, not resource-shaped — expose the
    // whole surface as a path proxy: itx.integrations.slack.chat.postMessage
    // posts https://slack.com/api/chat.postMessage with the placeholder
    // token, substituted by ctx.fetch (the terminal egress pipe).
    const token = ctx.secretRef(SLACK_ACCESS_TOKEN_SECRET_NAME);
    const method = (path: string[]) => {
      return async (body?: Record<string, unknown>) => {
        const response = await ctx.fetch(`https://slack.com/api/${path.join(".")}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body ?? {}),
        });
        const result = (await response.json()) as { error?: string; ok?: boolean };
        if (!response.ok || result.ok === false) {
          throw new Error(
            `Slack Web API ${path.join(".")} failed: ${result.error ?? response.status}`,
          );
        }
        return result;
      };
    };
    const node = (path: string[]): object =>
      new Proxy(method(path), {
        get: (target, key) =>
          typeof key === "string" ? node([...path, key]) : Reflect.get(target, key),
      });
    return node([]) as object;
  },
};

async function handleSlackWebhook(
  ctx: Parameters<NonNullable<IntegrationDefinition["fetch"]>>[0],
  parsePayload: (body: string) => Record<string, unknown> | null,
): Promise<Response> {
  const slack = ctx.config.integrations.slack;
  if (!slack) {
    return Response.json({ error: "Slack integration is not configured." }, { status: 503 });
  }

  const bodyText = await ctx.request.text();
  const timestamp = ctx.request.headers.get("x-slack-request-timestamp");
  const signature = ctx.request.headers.get("x-slack-signature");
  if (!timestamp || !signature || !Number.isFinite(Number.parseInt(timestamp, 10))) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }
  const expected = `v0=${await hmacSha256Hex({
    secret: slack.webhookSigningSecret.exposeSecret(),
    message: `v0:${timestamp}:${bodyText}`,
  })}`;
  if (!constantTimeEqual(expected, signature)) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }

  const payload = parsePayload(bodyText);
  if (!payload) {
    return Response.json({ error: "Slack webhook payload is invalid." }, { status: 400 });
  }
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }
  const teamId = readSlackTeamId(payload);
  if (!teamId) {
    return Response.json({ error: "Slack webhook is missing team_id." }, { status: 400 });
  }

  await ctx.capture({
    transport: "webhook",
    routingKey: slackTeamRoutingKey(teamId),
    idempotencyKey:
      typeof payload.event_id === "string"
        ? `event:${payload.event_id}`
        : typeof payload.trigger_id === "string"
          ? `trigger:${payload.trigger_id}`
          : null,
    body: payload,
  });
  return Response.json({ ok: true });
}

async function handleSlackOAuthCallback(
  ctx: Parameters<NonNullable<IntegrationDefinition["fetch"]>>[0],
): Promise<Response> {
  const slack = ctx.config.integrations.slack;
  if (!slack) {
    return Response.json({ error: "Slack integration is not configured." }, { status: 503 });
  }
  const url = new URL(ctx.request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state) return Response.json({ error: "Missing OAuth state." }, { status: 400 });
  const stateData = await ctx.oauthState.verify(state);
  if (!stateData || stateData.provider !== "slack") {
    return Response.json({ error: "Invalid or expired OAuth state." }, { status: 400 });
  }
  if (url.searchParams.get("error")) {
    return redirectWithError(stateData.callbackUrl, "slack_oauth_denied");
  }
  if (!code) return redirectWithError(stateData.callbackUrl, "slack_oauth_missing_code");

  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    body: new URLSearchParams({
      client_id: slack.oauthClientId,
      client_secret: slack.oauthClientSecret.exposeSecret(),
      code,
      redirect_uri: `${ctx.baseUrl.replace(/\/$/, "")}/api/integrations/slack/callback`,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    ok?: boolean;
    team?: { id?: string; name?: string; domain?: string };
  };
  if (
    !tokenResponse.ok ||
    tokenData.ok === false ||
    !tokenData.access_token ||
    !tokenData.team?.id
  ) {
    return redirectWithError(stateData.callbackUrl, tokenData.error ?? "slack_oauth_failed");
  }

  const routingKey = slackTeamRoutingKey(tokenData.team.id);
  const connectInput = {
    account: slackAccountForTeam(tokenData.team.id),
    projectId: stateData.projectId,
    ownership: "first-party" as const,
    externalId: tokenData.team.id,
    displayName: tokenData.team.name ?? tokenData.team.id,
    routingKeys: [routingKey],
    secrets: [
      {
        name: SLACK_ACCESS_TOKEN_SECRET_NAME,
        material: tokenData.access_token,
        metadata: {
          provider: "slack",
          scopes: slack.scopes,
          teamId: tokenData.team.id,
          teamName: tokenData.team.name ?? tokenData.team.id,
        },
      },
    ],
  };

  // The workspace may already be routed to ANOTHER project (one shared
  // first-party Slack app). Moving it needs explicit consent: pause the
  // connect into a sealed token and bounce to the takeover interstitial.
  const owner = await ctx.routeOwner({ routingKey });
  if (owner != null && owner.projectId !== stateData.projectId) {
    const pending = await ctx.sealPendingConnect({
      integration: "slack",
      connect: connectInput,
      conflict: { routingKey, owner },
    });
    const target = new URL(stateData.callbackUrl ?? "/", ctx.baseUrl);
    target.searchParams.set("pending_connect", pending);
    return Response.redirect(target.toString(), 302);
  }

  // The whole connection is ONE append from here.
  await ctx.connect(connectInput);
  return Response.redirect(stateData.callbackUrl ?? "/", 302);
}

function readSlackTeamId(payload: Record<string, unknown>): string | null {
  if (typeof payload.team_id === "string") return payload.team_id;
  const team = payload.team;
  if (team && typeof team === "object" && !Array.isArray(team)) {
    const id = (team as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  const event = payload.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const eventTeam = (event as Record<string, unknown>).team;
    if (typeof eventTeam === "string") return eventTeam;
  }
  return null;
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function redirectWithError(callbackUrl: string | undefined, error: string) {
  if (!callbackUrl) return Response.redirect(`/?error=${encodeURIComponent(error)}`, 302);
  const url = new URL(callbackUrl);
  url.searchParams.set("error", error);
  return Response.redirect(url.toString(), 302);
}
