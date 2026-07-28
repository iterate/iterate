// Telegram's inbound-webhook fetch: an imperative handler (like Slack's and
// GitHub's) over the shared routing primitive.
//
// Telegram `Update` payloads do not identify the bot, so the bot id rides the
// PATH: `/api/integrations/telegram/webhook/<botId>`. Verification is the
// static `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes on every
// delivery — set at connect time via setWebhook, and DERIVED (not stored):
// hmac(SECRET_ENCRYPTION_KEY, "telegram-webhook:<botId>"), so the connect flow
// and this door compute it independently and no new deployment secret exists
// (see telegramWebhookSecretToken).
//
// Same ACK-and-drop rule as Slack/GitHub: a bad or missing secret token → 401
// (the header is the entire trust boundary); validly authenticated but
// unroutable — unparseable body, no update_id, unclaimed bot — → 200 with an
// `ignored` reason, so Telegram stops retrying deliveries we will never want.
// Dedupe: Telegram retries undelivered updates, and `update_id` is the
// delivery identity, so the idempotency key is
// `telegram-webhook:<botId>:<update_id>`.

import { itxEnv } from "../../env.ts";
import { timingSafeStringEqual } from "../secrets/utils.ts";
import { routeIntegrationWebhook } from "./integration-streams.ts";
import { parseJsonRecord, telegramWebhookSecretToken } from "./utils.ts";
import type { AppConfig } from "~/config.ts";

const WEBHOOK_PATH_PREFIX = "/api/integrations/telegram/webhook/";

type TelegramWebhookDeps = {
  routeWebhook: typeof routeIntegrationWebhook;
  /** Lazy: resolved per request so importing this module in a plain-Node test
   * never touches the workerd-only env. */
  secretEncryptionKey: () => string;
};

/**
 * The dependency-injected door body — tests construct it with a fake router
 * and a fixed key (no module mocking); production wires the real halves below.
 */
export function createTelegramWebhookFetch(deps: TelegramWebhookDeps) {
  return async function fetchTelegramWebhookWithDeps(input: {
    config: AppConfig;
    request: Request;
  }): Promise<Response | null> {
    const pathname = new URL(input.request.url).pathname;
    if (!pathname.startsWith(WEBHOOK_PATH_PREFIX)) return null;
    const botId = pathname.slice(WEBHOOK_PATH_PREFIX.length);
    if (!botId || botId.includes("/")) return null;

    const expected = await telegramWebhookSecretToken({
      botId,
      keyMaterial: deps.secretEncryptionKey(),
    });
    const provided = input.request.headers.get("x-telegram-bot-api-secret-token");
    // Trust boundary — the only authored non-2xx. Durable routing/readiness
    // failures still throw so Telegram retries instead of our ACKing data loss.
    if (!provided || !timingSafeStringEqual(expected, provided)) {
      return Response.json({ error: "Invalid Telegram secret token." }, { status: 401 });
    }

    // Authenticated → every "can't use this" branch ACKs 200 and drops.
    const update = parseJsonRecord(await input.request.text());
    if (!update) return Response.json({ ignored: "unparseable-payload", ok: true });
    const updateId = update.update_id;
    if (typeof updateId !== "number") {
      return Response.json({ ignored: "no-update-id", ok: true });
    }

    const result = await deps.routeWebhook({
      event: {
        idempotencyKey: `telegram-webhook:${botId}:${updateId}`,
        // The exact shape the telegram router + agent processors read.
        payload: { body: update, botId },
        type: "events.iterate.com/telegram/webhook-received",
      },
      externalId: botId,
      routerCreatedEventType: "events.iterate.com/telegram/created",
      slug: "telegram",
    });
    if ("ignored" in result) return Response.json({ ignored: result.ignored, ok: true });
    return Response.json({ ok: true });
  };
}

/** Serve one Telegram webhook request, or null if the path isn't Telegram's. */
export const fetchTelegramWebhook = createTelegramWebhookFetch({
  routeWebhook: routeIntegrationWebhook,
  secretEncryptionKey: () => itxEnv.SECRET_ENCRYPTION_KEY,
});
