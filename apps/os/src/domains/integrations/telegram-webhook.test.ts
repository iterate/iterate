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
  test("valid secret token + claimed bot → routes on (telegram, botId) and 200", async () => {
    const { fetchWebhook, routed } = setup();
    const response = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ update: update(1001) }),
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      slug: "telegram",
      externalId: BOT_ID,
      event: {
        idempotencyKey: `telegram-webhook:${BOT_ID}:1001`,
        type: "events.iterate.com/telegram/webhook-received",
        payload: { botId: BOT_ID, body: update(1001) },
      },
    });
  });

  test("wrong secret token → 401, never routes (the trust boundary)", async () => {
    const { fetchWebhook, routed } = setup();
    const response = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ secretToken: "not-the-derived-token", update: update(1) }),
    });
    expect(response?.status).toBe(401);
    expect(routed).toHaveLength(0);
  });

  test("missing secret token header → 401", async () => {
    const { fetchWebhook, routed } = setup();
    const response = await fetchWebhook({
      config: config(),
      request: new Request(`https://os.example.test/api/integrations/telegram/webhook/${BOT_ID}`, {
        body: JSON.stringify(update(1)),
        method: "POST",
      }),
    });
    expect(response?.status).toBe(401);
    expect(routed).toHaveLength(0);
  });

  test("a token derived for ANOTHER bot id does not open this bot's door", async () => {
    const { fetchWebhook, routed } = setup();
    const otherBotToken = await telegramWebhookSecretToken({
      botId: "9999999",
      keyMaterial: SECRET_ENCRYPTION_KEY,
    });
    const response = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ secretToken: otherBotToken, update: update(1) }),
    });
    expect(response?.status).toBe(401);
    expect(routed).toHaveLength(0);
  });

  test("authenticated but unclaimed bot → 200 ACK-and-drop", async () => {
    const { fetchWebhook } = setup({ claimed: false });
    const response = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ update: update(1) }),
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ignored: "external-id-not-claimed" });
  });

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

  test("unparseable and update_id-less payloads → 200 ACK-and-drop", async () => {
    const { fetchWebhook, routed } = setup();
    const unparseable = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ rawBody: "not json{" }),
    });
    expect(unparseable?.status).toBe(200);
    expect(await unparseable?.json()).toMatchObject({ ignored: "unparseable-payload" });

    const noUpdateId = await fetchWebhook({
      config: config(),
      request: await webhookRequest({ rawBody: JSON.stringify({ message: { text: "hi" } }) }),
    });
    expect(noUpdateId?.status).toBe(200);
    expect(await noUpdateId?.json()).toMatchObject({ ignored: "no-update-id" });
    expect(routed).toHaveLength(0);
  });

  test("non-telegram paths → null (not mine)", async () => {
    const { fetchWebhook } = setup();
    for (const path of [
      "/api/integrations/slack/webhook",
      "/api/integrations/telegram/webhook", // no bot id segment
      `/api/integrations/telegram/webhook/${BOT_ID}/extra`,
    ]) {
      const response = await fetchWebhook({
        config: config(),
        request: new Request(`https://os.example.test${path}`, { body: "{}", method: "POST" }),
      });
      expect(response).toBeNull();
    }
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

async function webhookRequest(input: {
  rawBody?: string;
  secretToken?: string;
  update?: Record<string, unknown>;
}) {
  const secretToken =
    input.secretToken ??
    (await telegramWebhookSecretToken({ botId: BOT_ID, keyMaterial: SECRET_ENCRYPTION_KEY }));
  return new Request(`https://os.example.test/api/integrations/telegram/webhook/${BOT_ID}`, {
    body: input.rawBody ?? JSON.stringify(input.update),
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secretToken,
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
