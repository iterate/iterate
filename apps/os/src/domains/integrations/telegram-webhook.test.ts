// The Telegram webhook door (telegram-webhook.ts), driven through its
// dependency-injection seam: a fake router that records (and idempotency-key
// dedupes, like the real Stream DO) what gets routed, and a fixed derived-token
// key. No module mocks. Pins the door's contract: bad/missing secret token →
// 401 (the trust boundary), authenticated-but-unroutable → 200 ACK-and-drop,
// and the update_id-keyed dedupe across Telegram's delivery retries.

import { describe, expect, test } from "vitest";
import { createTelegramWebhookFetch } from "./telegram-webhook.ts";
import { telegramWebhookSecretToken } from "./utils.ts";
import { parseConfig } from "~/config.ts";

const SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";
const BOT_ID = "7000001";

describe("fetchTelegramWebhook", () => {
  test.for([
    {
      name: "valid secret token + claimed bot → routes on (telegram, botId) and 200",
      update: update(1001),
      expectedStatus: 200,
      expectedBody: { ok: true },
      expectedRoutedCount: 1,
      expectedRouted: {
        slug: "telegram",
        externalId: BOT_ID,
        routerProcessorSlug: "telegram",
        event: {
          idempotencyKey: `telegram-webhook:${BOT_ID}:1001`,
          type: "events.iterate.com/telegram/webhook-received",
          payload: { botId: BOT_ID, body: update(1001) },
        },
      },
    },
    {
      name: "wrong secret token → 401, never routes (the trust boundary)",
      secretToken: "not-the-derived-token",
      update: update(1),
      expectedStatus: 401,
      expectedBody: { error: "Invalid Telegram secret token." },
      expectedRoutedCount: 0,
    },
    {
      name: "missing secret token header → 401",
      secretToken: null,
      update: update(1),
      expectedStatus: 401,
      expectedBody: { error: "Invalid Telegram secret token." },
      expectedRoutedCount: 0,
    },
    {
      name: "a token derived for ANOTHER bot id does not open this bot's door",
      secretTokenForBotId: "9999999",
      update: update(1),
      expectedStatus: 401,
      expectedBody: { error: "Invalid Telegram secret token." },
      expectedRoutedCount: 0,
    },
    {
      name: "authenticated but unclaimed bot → 200 ACK-and-drop",
      claimed: false,
      update: update(1),
      expectedStatus: 200,
      expectedBody: { ignored: "external-id-not-claimed", ok: true },
      expectedRoutedCount: 0,
    },
    {
      name: "unparseable payloads → 200 ACK-and-drop",
      rawBody: "not json{",
      expectedStatus: 200,
      expectedBody: { ignored: "unparseable-payload", ok: true },
      expectedRoutedCount: 0,
    },
    {
      name: "update_id-less payloads → 200 ACK-and-drop",
      rawBody: JSON.stringify({ message: { text: "hi" } }),
      expectedStatus: 200,
      expectedBody: { ignored: "no-update-id", ok: true },
      expectedRoutedCount: 0,
    },
    {
      name: "another integration's webhook path → null (not mine)",
      path: "/api/integrations/slack/webhook",
      expectedStatus: null,
      expectedRoutedCount: 0,
    },
    {
      name: "the bot-id-less telegram webhook path → null (not mine)",
      path: "/api/integrations/telegram/webhook",
      expectedStatus: null,
      expectedRoutedCount: 0,
    },
    {
      name: "extra path segments after the bot id → null (not mine)",
      path: `/api/integrations/telegram/webhook/${BOT_ID}/extra`,
      expectedStatus: null,
      expectedRoutedCount: 0,
    },
  ])(
    "$name",
    async ({
      claimed,
      expectedBody,
      expectedRouted,
      expectedRoutedCount,
      expectedStatus,
      path,
      rawBody,
      secretToken,
      secretTokenForBotId,
      update: updateBody,
    }) => {
      const { fetchWebhook, routed } = setup(claimed === false ? { claimed } : {});
      const request =
        path !== undefined
          ? new Request(`https://os.example.test${path}`, { body: "{}", method: "POST" })
          : await webhookRequest({
              rawBody,
              secretToken:
                secretTokenForBotId === undefined
                  ? secretToken
                  : await telegramWebhookSecretToken({
                      botId: secretTokenForBotId,
                      keyMaterial: SECRET_ENCRYPTION_KEY,
                    }),
              update: updateBody,
            });

      const response = await fetchWebhook({ config: config(), request });

      if (expectedStatus === null) {
        expect(response).toBeNull();
      } else {
        expect(response?.status).toBe(expectedStatus);
        expect(await response?.json()).toEqual(expectedBody);
      }
      expect(routed).toHaveLength(expectedRoutedCount);
      if (expectedRouted !== undefined) {
        expect(routed[0]).toMatchObject(expectedRouted);
      }
    },
  );

  test("duplicate update_id dedupes (Telegram retries undelivered updates)", async () => {
    const { fetchWebhook, routedEvents } = setup();
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await fetchWebhook({
        config: config(),
        request: await webhookRequest({ update: update(2002) }),
      });
      expect(response?.status).toBe(200);
    }
    // Both deliveries carried the same idempotency key; the (fake, but
    // Stream-DO-faithful) journal holds one event.
    expect(routedEvents).toHaveLength(1);

    const next = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ update: update(2003) }),
    });
    expect(next?.status).toBe(200);
    expect(routedEvents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function config() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({ baseUrl: "https://os.example.test", openAiApiKey: "test-key" }),
  });
}

function update(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: 555, is_bot: false, first_name: "Misha" },
      chat: { id: 42, type: "private" },
      text: "hello",
    },
  };
}

/** `secretToken` undefined → the valid derived token; null → omit the header. */
async function webhookRequest(input: {
  rawBody?: string;
  secretToken?: string | null;
  update?: Record<string, unknown>;
}) {
  const secretToken =
    input.secretToken === undefined
      ? await telegramWebhookSecretToken({ botId: BOT_ID, keyMaterial: SECRET_ENCRYPTION_KEY })
      : input.secretToken;
  return new Request(`https://os.example.test/api/integrations/telegram/webhook/${BOT_ID}`, {
    body: input.rawBody ?? JSON.stringify(input.update),
    headers: {
      "content-type": "application/json",
      ...(secretToken === null ? {} : { "x-telegram-bot-api-secret-token": secretToken }),
    },
    method: "POST",
  });
}

/** The DI'd door plus a Stream-DO-faithful fake router: routed events land in
 * one in-memory journal that dedupes on idempotency key, exactly like the real
 * append lane the router feeds. */
function setup(options: { claimed?: boolean } = {}) {
  const routed: Array<{ event: { idempotencyKey: string }; externalId: string; slug: string }> = [];
  const routedEvents: Array<{ idempotencyKey: string }> = [];
  const fetchWebhook = createTelegramWebhookFetch({
    routeWebhook: async (input) => {
      if (options.claimed === false) return { ignored: "external-id-not-claimed", ok: true };
      routed.push(input);
      if (!routedEvents.some((event) => event.idempotencyKey === input.event.idempotencyKey)) {
        routedEvents.push(input.event);
      }
      return { connection: "mishas-helper-bot", ok: true, projectId: "prj_1" };
    },
    secretEncryptionKey: () => SECRET_ENCRYPTION_KEY,
  });
  return { fetchWebhook, routed, routedEvents };
}
