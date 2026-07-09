// Unit tests for connectTelegram + the telegram status/disconnect arms. No
// OAuth here: connect is getMe → claim check → setWebhook → recordConnection.
// The Telegram Bot API side is a REAL local HTTP server (no fetch mocking),
// pointed at via config.integrations.telegram.apiBaseUrl — the dependency
// injection that config knob exists for. Durable Object storage is the same
// in-memory itxEnv seam as github-connect.test.ts / google-connection.test.ts.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  CONNECTION_CLAIMED_EVENT_TYPE,
  CONNECTION_UNCLAIMED_EVENT_TYPE,
  INTEGRATION_DIRECTORY_STREAM_PATH,
  TELEGRAM_CONNECTED_EVENT_TYPE,
  TELEGRAM_DISCONNECTED_EVENT_TYPE,
  integrationConnectionStreamPath,
  telegramBotTokenSecretPath,
  telegramWebhookSecretToken,
} from "./utils.ts";
import { parseConfig } from "~/config.ts";

const network = vi.hoisted(() => {
  type StoredEvent = { idempotencyKey?: string; offset: number; payload: unknown; type: string };
  const streams = new Map<string, StoredEvent[]>();
  // One entry per append CALL: which stream, which event types — so tests can
  // assert atomicity (e.g. the steal's [unclaim, claim] committing as one
  // directory append, never two).
  const appendBatches: Array<{ name: string; types: string[] }> = [];
  const secrets = new Map<
    string,
    { egress?: { urls: string[] }; material?: unknown; refresh?: unknown }
  >();
  return {
    SECRET: {
      getByName(name: string) {
        return {
          async update(input: { egress?: { urls: string[] }; material?: unknown }) {
            secrets.set(name, { ...secrets.get(name), ...input });
          },
        };
      },
    },
    STREAM: {
      getByName(name: string) {
        let events = streams.get(name);
        if (!events) {
          events = [];
          streams.set(name, events);
        }
        const stored = events;
        return {
          async append(
            ...inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>
          ) {
            appendBatches.push({ name, types: inputs.map((input) => input.type) });
            return inputs.map((input) => {
              const existing =
                input.idempotencyKey === undefined
                  ? undefined
                  : stored.find((event) => event.idempotencyKey === input.idempotencyKey);
              if (existing) return existing;
              const event = { ...input, offset: stored.length + 1 };
              stored.push(event);
              return event;
            });
          },
          async runtimeState() {
            return { coreProcessorState: { maxOffset: stored.length } };
          },
          async getEvents(
            input: { afterOffset?: number; beforeOffset?: number; limit?: number } = {},
          ) {
            const { afterOffset = 0, beforeOffset = Infinity, limit = 500 } = input;
            return stored
              .filter((event) => event.offset > afterOffset && event.offset < beforeOffset)
              .slice(0, limit);
          },
        };
      },
    },
    reset() {
      streams.clear();
      secrets.clear();
      appendBatches.length = 0;
    },
    appendBatches,
    secrets,
    streams,
  };
});

const SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";

// connect-flows imports slack-api (disconnect's auth.revoke), which drags the
// worker-only egress entrypoint into the module graph; sever that edge — these
// tests never touch slack. telegram-api is severed for the same module-graph
// reason, but its two members stay REAL enough to matter: telegramApiBaseUrl
// keeps its actual behavior (the connect flow reads the fake server's base URL
// through it) and callProjectTelegramBotApi records the disconnect flow's
// best-effort deleteWebhook.
vi.mock("./slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));
const callProjectTelegramBotApi = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("./telegram-api.ts", () => ({
  callProjectTelegramBotApi,
  telegramApiBaseUrl: (config: { integrations: { telegram: { apiBaseUrl: string } } }) =>
    config.integrations.telegram.apiBaseUrl.replace(/\/$/, ""),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    SECRET: network.SECRET,
    SECRET_ENCRYPTION_KEY: "test-secret-encryption-key",
    STREAM: network.STREAM,
  },
}));

const { connectTelegram, disconnectProvider, getConnectionStatus } =
  await import("./connect-flows.ts");

const PROJECT_ID = "prj_test";
const BOT_ID = "7000001";
const BOT_TOKEN = `${BOT_ID}:AAHtestTOKENtestTOKENtestTOKEN`;

describe("connectTelegram", () => {
  afterEach(() => {
    network.reset();
    callProjectTelegramBotApi.mockReset();
  });

  test("valid token: getMe names the connection, setWebhook gets the derived secret token, storage records everything", async () => {
    // Claim-first ordering: by the time Telegram is told about the webhook,
    // the directory claim must already exist — an update arriving the instant
    // registration completes has a claim to route on (the door ACK-drops
    // unclaimed bots, and Telegram never retries an ACK).
    let claimedAtSetWebhookTime: number | undefined;
    await using api = await startFakeTelegramApi({
      onSetWebhook: () => {
        claimedAtSetWebhookTime = directoryEvents().filter(
          (event) => event.type === CONNECTION_CLAIMED_EVENT_TYPE,
        ).length;
      },
    });

    const result = await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });
    expect(result).toEqual({
      botId: BOT_ID,
      botUsername: "MishasHelperBot",
      connection: "mishashelperbot",
      ok: true,
    });

    // The Bot API saw getMe then setWebhook, both with the pasted token in the
    // URL path, and setWebhook got the per-bot webhook URL + DERIVED secret
    // token (hmac of SECRET_ENCRYPTION_KEY — nothing stored anywhere).
    expect(api.requests.map((request) => request.path)).toEqual([
      `/bot${BOT_TOKEN}/getMe`,
      `/bot${BOT_TOKEN}/setWebhook`,
      `/bot${BOT_TOKEN}/setMyCommands`,
    ]);
    expect(claimedAtSetWebhookTime).toBe(1);
    expect(api.requests[1]!.body).toEqual({
      secret_token: await telegramWebhookSecretToken({
        botId: BOT_ID,
        keyMaterial: SECRET_ENCRYPTION_KEY,
      }),
      url: `https://os.example.test/api/integrations/telegram/webhook/${BOT_ID}`,
    });
    // The command menu advertises both verbs the processors understand.
    expect(api.requests[2]!.body).toEqual({
      commands: [
        { command: "new", description: "Start a fresh thread" },
        { command: "debug", description: "Show agent debug info" },
      ],
    });

    // The token lands in the connection secret, egress pinned to the Bot API
    // origin — the only place it is ever useful.
    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: telegramBotTokenSecretPath("mishashelperbot"),
    });
    expect(network.secrets.get(secretName)).toMatchObject({
      egress: { urls: [new URL(api.baseUrl).origin] },
      material: BOT_TOKEN,
    });

    // Connected fact + the router's processor subscription on the connection
    // stream; the directory claim (botId → project + connection) for routing.
    const journal = network.streams.get(
      DurableObjectNameCodec.stringify({
        projectId: PROJECT_ID,
        path: integrationConnectionStreamPath("telegram", "mishashelperbot"),
      }),
    );
    expect(journal?.map((event) => event.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      TELEGRAM_CONNECTED_EVENT_TYPE,
    ]);
    expect(journal?.[1]).toMatchObject({
      payload: {
        botId: BOT_ID,
        botUsername: "MishasHelperBot",
        connection: "mishashelperbot",
        externalId: BOT_ID,
        projectId: PROJECT_ID,
      },
    });
    const claims = network.streams.get(
      DurableObjectNameCodec.stringify(
        { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
        { allowNullProjectId: true },
      ),
    );
    expect(claims).toHaveLength(1);
    expect(claims?.[0]).toMatchObject({
      type: CONNECTION_CLAIMED_EVENT_TYPE,
      payload: {
        connection: "mishashelperbot",
        externalId: BOT_ID,
        projectId: PROJECT_ID,
        slug: "telegram",
      },
    });
  });

  test("an invalid token fails on getMe with Telegram's reason; nothing is stored", async () => {
    await using api = await startFakeTelegramApi();
    await expect(
      connectTelegram({
        botToken: "12345:WRONG",
        config: config(api.baseUrl),
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow(/getMe failed: Unauthorized/);
    expect(network.secrets.size).toBe(0);
    expect(api.requests.map((request) => request.path)).toEqual(["/bot12345:WRONG/getMe"]);
  });

  test("a bot claimed by another project answers the structured already-claimed arm (no steal, no leak)", async () => {
    await using api = await startFakeTelegramApi();
    await seedDirectoryClaim({ connection: "their-bot", projectId: "prj_other" });

    const result = await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });
    // Structured — not thrown — so the dashboard can offer the steal. The
    // holding project is never named (the caller may be a different org).
    expect(result).toEqual({
      botUsername: "MishasHelperBot",
      error: "telegram_bot_already_claimed",
      ok: false,
    });
    // getMe ran (we need the bot id to check the claim); setWebhook never did,
    // and nothing was stored or dispossessed.
    expect(api.requests.map((request) => request.path)).toEqual([`/bot${BOT_TOKEN}/getMe`]);
    expect(network.secrets.size).toBe(0);
    const claims = network.streams.get(
      DurableObjectNameCodec.stringify(
        { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
        { allowNullProjectId: true },
      ),
    );
    expect(claims).toHaveLength(1); // the other project's claim stands
  });

  test("steal: true dispossesses the old project, then claims for the caller", async () => {
    await using api = await startFakeTelegramApi();
    // The old project holds the bot: directory claim + a live-looking secret.
    await seedDirectoryClaim({ connection: "their-bot", projectId: "prj_other" });
    const oldSecretName = DurableObjectNameCodec.stringify({
      projectId: "prj_other",
      path: telegramBotTokenSecretPath("their-bot"),
    });
    await network.SECRET.getByName(oldSecretName).update({
      egress: { urls: ["https://api.telegram.org"] },
      material: BOT_TOKEN,
    });

    const result = await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
      steal: true,
    });
    expect(result).toEqual({
      botId: BOT_ID,
      botUsername: "MishasHelperBot",
      connection: "mishashelperbot", // fresh name — the old one belonged to the old project
      ok: true,
    });

    // The old project's stored token is unusable (egress emptied)…
    expect(network.secrets.get(oldSecretName)).toMatchObject({ egress: { urls: [] } });
    // …its journal shows the disconnect (without naming the taker)…
    const oldJournal = network.streams.get(
      DurableObjectNameCodec.stringify({
        projectId: "prj_other",
        path: integrationConnectionStreamPath("telegram", "their-bot"),
      }),
    );
    expect(oldJournal?.at(-1)).toMatchObject({
      type: TELEGRAM_DISCONNECTED_EVENT_TYPE,
      payload: {
        connection: "their-bot",
        projectId: "prj_other",
        reason: "stolen-by-another-project",
      },
    });
    // …and no deleteWebhook was sent on the old side (the webhook is
    // re-registered for the same bot moments later).
    expect(callProjectTelegramBotApi).not.toHaveBeenCalled();
    expect(api.requests.map((request) => request.path)).toEqual([
      `/bot${BOT_TOKEN}/getMe`,
      `/bot${BOT_TOKEN}/setWebhook`,
      `/bot${BOT_TOKEN}/setMyCommands`,
    ]);

    // The directory fold now answers the CALLER's claim.
    const directory = network.streams.get(
      DurableObjectNameCodec.stringify(
        { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
        { allowNullProjectId: true },
      ),
    );
    expect(directory?.map((event) => event.type)).toEqual([
      CONNECTION_CLAIMED_EVENT_TYPE,
      CONNECTION_UNCLAIMED_EVENT_TYPE,
      CONNECTION_CLAIMED_EVENT_TYPE,
    ]);
    // The swap is ATOMIC: old-unclaim + new-claim in ONE directory append —
    // a stolen bot has live traffic throughout, and any window between the
    // two would ACK-and-drop updates that Telegram never retries.
    const directoryName = DurableObjectNameCodec.stringify(
      { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
      { allowNullProjectId: true },
    );
    const swapBatch = network.appendBatches.find(
      (batch) =>
        batch.name === directoryName && batch.types.includes(CONNECTION_UNCLAIMED_EVENT_TYPE),
    );
    expect(swapBatch).toMatchObject({
      types: [CONNECTION_UNCLAIMED_EVENT_TYPE, CONNECTION_CLAIMED_EVENT_TYPE],
    });
    // And the ordering around the swap eliminates every broken window: the
    // NEW connection is fully prepared (connected fact + arm) BEFORE routing
    // flips, and the OLD project is dispossessed only AFTER — until the swap
    // its token still works (clean handling continues), and after it the
    // brief live-token tail just drains in-flight replies.
    const batchIndex = (predicate: (batch: { name: string; types: string[] }) => boolean) =>
      network.appendBatches.findIndex(predicate);
    const newConnectedIndex = batchIndex(
      (batch) =>
        batch.name.includes("mishashelperbot") &&
        batch.types.includes(TELEGRAM_CONNECTED_EVENT_TYPE),
    );
    const swapIndex = batchIndex((batch) => batch === swapBatch);
    const oldDisconnectedIndex = batchIndex(
      (batch) =>
        batch.name.includes("their-bot") && batch.types.includes(TELEGRAM_DISCONNECTED_EVENT_TYPE),
    );
    expect(newConnectedIndex).toBeGreaterThanOrEqual(0);
    expect(newConnectedIndex).toBeLessThan(swapIndex);
    expect(swapIndex).toBeLessThan(oldDisconnectedIndex);
    expect(directory?.at(-1)).toMatchObject({
      payload: { connection: "mishashelperbot", externalId: BOT_ID, projectId: PROJECT_ID },
    });

    // The caller got the full connect: secret + connected fact.
    const newJournal = network.streams.get(
      DurableObjectNameCodec.stringify({
        projectId: PROJECT_ID,
        path: integrationConnectionStreamPath("telegram", "mishashelperbot"),
      }),
    );
    expect(newJournal?.at(-1)).toMatchObject({
      type: TELEGRAM_CONNECTED_EVENT_TYPE,
      payload: { connection: "mishashelperbot", projectId: PROJECT_ID },
    });
  });

  test("reconnecting the same project reuses the claiming connection's name (the Slack rule)", async () => {
    await using api = await startFakeTelegramApi();
    await seedDirectoryClaim({ connection: "my-old-name", projectId: PROJECT_ID });

    const result = await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });
    expect(result).toMatchObject({ connection: "my-old-name", ok: true });
  });

  test("a setMyCommands failure never fails the connect (the / menu is cosmetic)", async () => {
    await using api = await startFakeTelegramApi({ failSetMyCommands: true });

    const result = await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });
    expect(result).toMatchObject({ connection: "mishashelperbot", ok: true });
    // The webhook is live, the claim stands, and status shows connected — a
    // missing command-menu entry must never roll any of that back.
    expect(api.requests.map((request) => request.path)).toEqual([
      `/bot${BOT_TOKEN}/getMe`,
      `/bot${BOT_TOKEN}/setWebhook`,
      `/bot${BOT_TOKEN}/setMyCommands`,
    ]);
    expect(directoryEvents().map((event) => event.type)).toEqual([CONNECTION_CLAIMED_EVENT_TYPE]);
    expect(
      await getConnectionStatus({
        connection: "mishashelperbot",
        projectId: PROJECT_ID,
        provider: "telegram",
      }),
    ).toMatchObject({ connected: true });
  });

  test("a setWebhook failure rolls the fresh connect back: no claim, disconnected status, bricked secret", async () => {
    await using api = await startFakeTelegramApi({ failSetWebhook: true });

    await expect(
      connectTelegram({ botToken: BOT_TOKEN, config: config(api.baseUrl), projectId: PROJECT_ID }),
    ).rejects.toThrow(/setWebhook failed: webhook set refused/);

    // Defense in depth: the rollback also tries deleteWebhook (a webhook that
    // DID register while the response failed would otherwise keep delivering
    // to a deployment that ACK-drops the unclaimed bot).
    expect(api.requests.map((request) => request.path)).toEqual([
      `/bot${BOT_TOKEN}/getMe`,
      `/bot${BOT_TOKEN}/setWebhook`,
      `/bot${BOT_TOKEN}/deleteWebhook`,
    ]);

    // Claim-first means the claim exists before setWebhook; the rollback
    // unclaims it, so the fold nets to nobody holding the bot and a retry
    // re-runs cleanly.
    expect(directoryEvents().map((event) => event.type)).toEqual([
      CONNECTION_CLAIMED_EVENT_TYPE,
      CONNECTION_UNCLAIMED_EVENT_TYPE,
    ]);
    // The dashboard sees reality (never a half-connected bot whose webhook
    // was never registered)…
    expect(
      await getConnectionStatus({
        connection: "mishashelperbot",
        projectId: PROJECT_ID,
        provider: "telegram",
      }),
    ).toMatchObject({ connected: false });
    // …and the stored token is unusable.
    expect(
      network.secrets.get(
        DurableObjectNameCodec.stringify({
          projectId: PROJECT_ID,
          path: telegramBotTokenSecretPath("mishashelperbot"),
        }),
      ),
    ).toMatchObject({ egress: { urls: [] } });
  });
});

describe("getConnectionStatus (telegram) + disconnect", () => {
  afterEach(() => {
    network.reset();
    callProjectTelegramBotApi.mockReset();
  });

  test("the latest lifecycle fact wins; connected exposes the bot identity", async () => {
    await using api = await startFakeTelegramApi();
    await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });

    expect(
      await getConnectionStatus({
        connection: "mishashelperbot",
        projectId: PROJECT_ID,
        provider: "telegram",
      }),
    ).toEqual({
      connected: true,
      displayName: "@MishasHelperBot",
      externalId: BOT_ID,
      metadata: {
        botFirstName: "Misha's helper",
        botId: BOT_ID,
        botUsername: "MishasHelperBot",
      },
    });
  });

  test("disconnect: best-effort deleteWebhook, egress emptied, disconnected fact, bot unclaimed", async () => {
    await using api = await startFakeTelegramApi();
    await connectTelegram({
      botToken: BOT_TOKEN,
      config: config(api.baseUrl),
      projectId: PROJECT_ID,
    });

    const result = await disconnectProvider({
      connection: "mishashelperbot",
      projectId: PROJECT_ID,
      provider: "telegram",
    });
    expect(result).toEqual({ success: true });

    // deleteWebhook rode the secret-substituted egress path (no material read).
    expect(callProjectTelegramBotApi).toHaveBeenCalledWith({
      body: {},
      connection: "mishashelperbot",
      method: "deleteWebhook",
      projectId: PROJECT_ID,
    });

    // Secrets have no delete: the emptied egress allowlist bricks the token.
    const secretName = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: telegramBotTokenSecretPath("mishashelperbot"),
    });
    expect(network.secrets.get(secretName)).toMatchObject({ egress: { urls: [] } });

    expect(
      await getConnectionStatus({
        connection: "mishashelperbot",
        projectId: PROJECT_ID,
        provider: "telegram",
      }),
    ).toMatchObject({ connected: false });

    const claims = network.streams.get(
      DurableObjectNameCodec.stringify(
        { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
        { allowNullProjectId: true },
      ),
    );
    expect(claims?.map((event) => event.type)).toEqual([
      CONNECTION_CLAIMED_EVENT_TYPE,
      CONNECTION_UNCLAIMED_EVENT_TYPE,
    ]);
    expect(claims?.[1]).toMatchObject({
      payload: { externalId: BOT_ID, projectId: PROJECT_ID, slug: "telegram" },
    });

    // The disconnected fact landed on the connection journal.
    const journal = network.streams.get(
      DurableObjectNameCodec.stringify({
        projectId: PROJECT_ID,
        path: integrationConnectionStreamPath("telegram", "mishashelperbot"),
      }),
    );
    expect(journal?.at(-1)).toMatchObject({
      type: TELEGRAM_DISCONNECTED_EVENT_TYPE,
      payload: { botId: BOT_ID, connection: "mishashelperbot", projectId: PROJECT_ID },
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function config(apiBaseUrl: string) {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      baseUrl: "https://os.example.test",
      integrations: { telegram: { apiBaseUrl } },
      openAiApiKey: "openai-test-key",
    }),
  });
}

/** The deployment-wide directory stream's events, as stored by the fake. */
function directoryEvents() {
  return (
    network.streams.get(
      DurableObjectNameCodec.stringify(
        { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
        { allowNullProjectId: true },
      ),
    ) ?? []
  );
}

async function seedDirectoryClaim(input: { connection: string; projectId: string }) {
  await network.STREAM.getByName(
    DurableObjectNameCodec.stringify(
      { projectId: null, path: INTEGRATION_DIRECTORY_STREAM_PATH },
      { allowNullProjectId: true },
    ),
  ).append({
    type: CONNECTION_CLAIMED_EVENT_TYPE,
    payload: {
      connection: input.connection,
      externalId: BOT_ID,
      projectId: input.projectId,
      slug: "telegram",
    },
  });
}

/** A controllable fake Telegram Bot API: real HTTP, one valid token, records
 * every request. `onSetWebhook` observes state AT registration time (the
 * claim-first ordering proof); `failSetWebhook` simulates Telegram refusing
 * the webhook. `await using` closes it when the test scope exits. */
async function startFakeTelegramApi(
  options: {
    failSetMyCommands?: boolean;
    failSetWebhook?: boolean;
    onSetWebhook?: () => void;
  } = {},
) {
  const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => {
      const path = request.url!;
      requests.push({ body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, path });
      const respond = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (!path.startsWith(`/bot${BOT_TOKEN}/`)) {
        return respond(401, { ok: false, description: "Unauthorized" });
      }
      if (path.endsWith("/getMe")) {
        return respond(200, {
          ok: true,
          result: {
            id: Number(BOT_ID),
            is_bot: true,
            first_name: "Misha's helper",
            username: "MishasHelperBot",
          },
        });
      }
      if (path.endsWith("/setMyCommands")) {
        if (options.failSetMyCommands === true) {
          return respond(500, { ok: false, description: "commands refused" });
        }
        return respond(200, { ok: true, result: true });
      }
      if (path.endsWith("/deleteWebhook")) {
        return respond(200, { ok: true, result: true });
      }
      if (path.endsWith("/setWebhook")) {
        options.onSetWebhook?.();
        if (options.failSetWebhook === true) {
          return respond(500, { ok: false, description: "webhook set refused" });
        }
        return respond(200, { ok: true, result: true, description: "Webhook was set" });
      }
      respond(404, { ok: false, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async [Symbol.asyncDispose]() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
