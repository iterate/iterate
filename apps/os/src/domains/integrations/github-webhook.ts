// GitHub's inbound-webhook fetch: an imperative handler (like Slack's) that
// verifies the App webhook signature, pulls the installation id, and routes the
// delivery to the claiming connection's stream. Same ACK-and-drop rule as Slack
// (a distributed App gets webhooks for orgs no project has claimed): validly
// signed but unroutable → 200-drop, bad signature → 401, unconfigured → 503.
// WebCrypto HMAC — same primitive as the Slack door and the Secret DO's hmac()
// (design R6). The small association extractor is typed from Octokit's
// generated event-name union, but signature verification stays at this door.

import { computeHmacHex, timingSafeStringEqual } from "../secrets/utils.ts";
import { routeIntegrationWebhook } from "./integration-streams.ts";
import { githubWebhookAssociations } from "./github-webhook-associations.ts";
import { GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE, parseJsonRecord, readString } from "./utils.ts";
import type { AppConfig } from "~/config.ts";

const WEBHOOK_PATH = "/api/integrations/github/webhook";

/** Serve one GitHub webhook request, or null if the path isn't GitHub's. */
export async function fetchGithubWebhook(input: {
  config: AppConfig;
  request: Request;
}): Promise<Response | null> {
  if (new URL(input.request.url).pathname !== WEBHOOK_PATH) return null;

  const secret = input.config.integrations.github?.webhookSecret;
  if (!secret) {
    return Response.json({ error: "GitHub integration is not configured." }, { status: 503 });
  }

  const body = await input.request.text();
  const verified = await verifyGithubWebhook({
    rawBody: body,
    signature256: input.request.headers.get("x-hub-signature-256"),
    webhookSecret: secret.exposeSecret(),
  });
  if (!verified) return Response.json({ error: "Invalid GitHub signature." }, { status: 401 });

  const delivery = input.request.headers.get("x-github-delivery")?.trim();
  const eventName = input.request.headers.get("x-github-event")?.trim();
  if (!delivery || !eventName) {
    return Response.json(
      { error: "Missing required GitHub webhook delivery headers." },
      { status: 400 },
    );
  }

  const payload = parseJsonRecord(body);
  if (!payload) return Response.json({ ignored: "unparseable-payload", ok: true });

  const installationId = githubWebhookExternalId(payload);
  if (!installationId) return Response.json({ ignored: "no-installation", ok: true });

  const action = readString(payload.action);
  const result = await routeIntegrationWebhook({
    event: {
      idempotencyKey: `github-webhook:${delivery}`,
      payload: {
        ...(input.config.integrations.github?.appSlug === undefined
          ? {}
          : { appSlug: input.config.integrations.github.appSlug }),
        associations: githubWebhookAssociations({ name: eventName, payload }),
        body: payload,
        delivery: {
          ...(action === undefined ? {} : { action }),
          id: delivery,
          name: eventName,
        },
        installationId,
      },
      type: GITHUB_WEBHOOK_RECEIVED_EVENT_TYPE,
    },
    externalId: installationId,
    slug: "github",
  });
  if ("ignored" in result) return Response.json({ ignored: result.ignored, ok: true });
  return Response.json({ ok: true });
}

/**
 * Verify a GitHub webhook's `x-hub-signature-256` (`sha256=<hex hmac>`) against
 * the App's webhook secret. Constant-time; a missing signature fails.
 */
async function verifyGithubWebhook(input: {
  rawBody: string;
  signature256: string | null;
  webhookSecret: string;
}): Promise<boolean> {
  if (!input.signature256) return false;
  const digest = await computeHmacHex({ key: input.webhookSecret, payload: input.rawBody });
  return timingSafeStringEqual(`sha256=${digest}`, input.signature256);
}

/**
 * The GitHub installation id an App webhook routes on — the `(github,
 * installation_id)` directory external id. Null when the delivery carries no
 * installation (some app-level pings).
 */
function githubWebhookExternalId(payload: Record<string, unknown>): string | null {
  const installation = payload.installation;
  if (installation !== null && typeof installation === "object" && !Array.isArray(installation)) {
    const id = (installation as { id?: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return String(id);
  }
  return null;
}
