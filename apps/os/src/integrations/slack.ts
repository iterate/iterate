// src/integrations/slack.ts — SLACK: a connection is one workspace (connections.ts). Its bot token,
// and for a project's own app the app's `clientId`, `clientSecret` and `signingSecret`, live in
// `/secrets/slack-<connection>`; outbound calls carry
// `getSecret("/secrets/slack-<connection>", { field: "accessToken" })` through egress.
//   connectSlack      → the consent URL (`itx.secrets.beginOAuth` with iterate's app,
//                       `client: { platform: "slack" }`, or the project's, `{ project: "slack" }`)
//   finishSlackConnect → the callback stored the token: `auth.test` names the workspace, iterate's
//                       app routes it here (control-plane/catalog.ts), `slack/connected` lands on `/`
//   disconnectSlack   → `auth.revoke`, the route released, the secret deleted, `slack/disconnected`
//   slackWebhookRoute → Slack's inbound requests, on the legacy platform's URLs:
//     POST /api/integrations/slack/{webhook,interactivity-webhook}                       iterate's app
//     POST /api/integrations/slack/{webhook,interactivity-webhook}/<projectId>/<connection>  own app
// A signed request lands on `<project>:/integrations/slack/<connection>` as
// `slack/webhook-received`, keyed `slack-webhook:<event_id|trigger_id>` (the codes: rules.ts).
import { codedError } from "iterate/lib";
import { appConfigOf, DEFAULT_SLACK_BOT_SCOPES } from "../app-config.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import { isRecord, verifySecretHmac } from "../secrets.ts";
import {
  appendPlatformFact,
  attemptKeyOf,
  connectionPathOf,
  connectionRowOf,
  ignoredWebhook,
  ownerEgress,
  routedWhile,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";
import {
  slackPayloadOf,
  slackSignatureValid,
  slackTeamIdOf,
  type HmacHexMatches,
} from "./rules.ts";

/** Where Slack answers, and the bot scopes asked for: iterate's app's (`slackOrigin` is a fake's on
 *  a preview), or the pin the project's own app's secret was set with. */
async function slackAppOf(
  scope: IntegrationScope,
  client: ConnectionAttempt["client"],
  connection: string,
): Promise<{ origin: string; scopes: readonly string[] }> {
  if (client === "iterate") {
    const slack = appConfigOf(scope.env).integrations.slack;
    if (!slack)
      throw codedError(
        "INVALID_INPUT",
        "This deployment has no Slack app (APP_CONFIG integrations.slack) — use your own.",
      );
    return { origin: slack.slackOrigin, scopes: slack.scopes };
  }
  const secretPath = tokenSecretPathOf("slack", connection);
  const secrets = await scope.withItx((itx) => itx.secrets.list());
  const pin = secrets.find((secret) => secret.path === secretPath)?.urls[0];
  if (!pin)
    throw codedError(
      "INVALID_INPUT",
      `Set ${secretPath} to your Slack app's { clientId, clientSecret, signingSecret }, pinned to https://slack.com, first.`,
    );
  return { origin: pin, scopes: DEFAULT_SLACK_BOT_SCOPES };
}

/** The bot token's Slack Web API call, through egress. */
function slackApi(scope: IntegrationScope, origin: string, method: string, connection: string) {
  return ownerEgress(
    scope.env,
    scope,
    new Request(`${origin}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer getSecret("${tokenSecretPathOf("slack", connection)}", { field: "accessToken" })`,
      },
    }),
  );
}

export async function connectSlack(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    /** More bot scopes than the app's default: a reinstall asks for the union. */
    scopes?: readonly string[];
    /** The team an existing connection holds: the reinstall must come back for it. */
    expectAccount?: string;
  },
): Promise<{ authorizationUrl: string }> {
  const { connection, client } = input;
  const { origin, scopes } = await slackAppOf(scope, client, connection);
  const { authorizationUrl } = await scope.withItx((itx) =>
    itx.secrets.beginOAuth(tokenSecretPathOf("slack", connection), {
      authorizationEndpoint: `${origin}/oauth/v2/authorize`,
      tokenEndpoint: `${origin}/api/oauth.v2.access`,
      client: client === "iterate" ? { platform: "slack" } : { project: "slack" },
      clientAuth: "client_secret_post",
      scope: [...new Set([...scopes, ...(input.scopes || [])])].join(","),
      // files.slack.com serves a shared file's download (url_private)
      urls: origin === "https://slack.com" ? [origin, "https://files.slack.com"] : [origin],
      next: input.next,
      expectAccount: input.expectAccount,
    }),
  );
  const attempt: ConnectionAttempt = { client, origin, until: Date.now() + SECRET_OAUTH_TTL_MS };
  await scope.storage.put(attemptKeyOf("slack", connection), attempt);
  return { authorizationUrl };
}

export async function finishSlackConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
): Promise<void> {
  const { env, projectId } = scope;
  const response = await slackApi(scope, attempt.origin, "auth.test", connection);
  const identity: unknown = await response.json().catch(() => null);
  if (!isRecord(identity) || identity.ok !== true || typeof identity.team_id !== "string")
    throw new Error(`Slack's auth.test answered ${response.status}`);
  const connected = () =>
    appendPlatformFact(env, projectId, "/", {
      type: "events.iterate.com/slack/connected",
      payload: {
        connection,
        client: attempt.client,
        account: typeof identity.team === "string" ? identity.team : identity.team_id,
        externalId: identity.team_id,
      },
    });
  // iterate's app routes the team here while `connected` lands; a failure puts the routes back
  if (attempt.client !== "iterate") return connected();
  const path = connectionPathOf("slack", connection);
  await routedWhile(
    env,
    { provider: "slack", externalId: identity.team_id, projectId, path },
    connected,
  );
}

export async function disconnectSlack(
  scope: IntegrationScope,
  connection: string,
  client: ConnectionAttempt["client"] | null,
): Promise<void> {
  const { env, projectId } = scope;
  // a token already dead is the goal, so the revoke is best-effort
  if (client)
    await slackAppOf(scope, client, connection)
      .then(({ origin }) => slackApi(scope, origin, "auth.revoke", connection))
      .then((response) => response.body?.cancel())
      .catch(() => {});
  await new ControlPlane(env).releaseIntegrationRoutes(
    projectId,
    connectionPathOf("slack", connection),
  );
  // a secret never set (consent never finished) throws, having dropped the attempt in flight
  await scope
    .withItx((itx) => itx.secrets.delete(tokenSecretPathOf("slack", connection)))
    .catch(() => {});
  await scope.storage.delete(attemptKeyOf("slack", connection));
  await appendPlatformFact(env, projectId, "/", {
    type: "events.iterate.com/slack/disconnected",
    payload: { connection },
  });
}

const SLACK_WEBHOOK_PATH =
  /^\/api\/integrations\/slack\/(webhook|interactivity-webhook)(?:\/([^/]+)\/([^/]+))?$/;

/** A Slack request's response (rules.ts), or null when the path is not Slack's. */
export async function slackWebhookRoute(request: Request, env: Env): Promise<Response | null> {
  const match = SLACK_WEBHOOK_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const [, endpoint, ownProjectId, ownConnection] = match;
  let hmacHexMatches: HmacHexMatches;
  let own: { projectId: string; path: string; externalId: string } | null = null;
  if (ownProjectId && ownConnection) {
    // A PROJECT'S OWN APP: the URL names the connection, which must be recorded as the project's
    // own before any secret is touched (a context is created on first touch).
    const project = await new ControlPlane(env).getProject(ownProjectId);
    const path = connectionPathOf("slack", ownConnection);
    const row = project && (await connectionRowOf(env, project.id, path));
    if (!project || row?.client !== "project") return ignoredWebhook("unknown-connection");
    own = { projectId: project.id, path, externalId: row.externalId };
    hmacHexMatches = async (payload, signature) =>
      (await env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId: project.id, path: "/" }),
      ).invoke(
        [
          "itx",
          "builtins",
          "secrets",
          [
            "verifyHmac",
            tokenSecretPathOf("slack", ownConnection),
            { payload, signature, field: "signingSecret" },
          ],
        ],
        [],
        { principal: null },
      )) === true;
  } else {
    const slack = appConfigOf(env).integrations.slack;
    if (!slack)
      return Response.json({ error: "Slack integration is not configured." }, { status: 503 });
    hmacHexMatches = (payload, signature) =>
      verifySecretHmac(slack.webhookSigningSecret.exposeSecret(), { payload, signature });
  }
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signed = await slackSignatureValid({
    rawBody,
    timestamp,
    signature: request.headers.get("x-slack-signature"),
    nowSeconds: Math.floor(Date.now() / 1000),
    hmacHexMatches,
  });
  if (!signed) return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  const body = slackPayloadOf(rawBody, endpoint === "interactivity-webhook");
  if (body?.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (!body) return ignoredWebhook("unparseable-payload");
  const teamId = slackTeamIdOf(body);
  if (!teamId) return ignoredWebhook("no-team-id");
  const route = own
    ? own.externalId === teamId
      ? own
      : null
    : await new ControlPlane(env).integrationRouteOf("slack", teamId);
  if (!route) return ignoredWebhook(own ? "other-team" : "unrouted-team");
  const eventId = typeof body.event_id === "string" ? body.event_id : null;
  const triggerId = typeof body.trigger_id === "string" ? body.trigger_id : null;
  try {
    await appendPlatformFact(env, route.projectId, route.path, {
      type: "events.iterate.com/slack/webhook-received",
      idempotencyKey: `slack-webhook:${eventId || triggerId || crypto.randomUUID()}`,
      payload: { body, teamId, slackRequestTimestamp: timestamp },
    });
  } catch (error) {
    // A redelivery carries a new timestamp, so its body differs from the one stored under the key
    // (stream.ts IDEMPOTENCY_CONFLICT, greppable across the hop): already stored.
    if (!String(error).includes("already names a different event")) throw error;
  }
  return Response.json({ ok: true });
}
