// Unit tests for getConnectionStatus's google behavior — the newest-first
// lifecycle fold over the connection journal. Tokens never live on the journal
// (they're in the connection secret, refreshed by the Secret DO's shared
// oauth-refresh-token strategy), so status is display metadata only. Same
// in-memory itxEnv seam as github-connect.test.ts.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  GITHUB_CONNECTED_EVENT_TYPE,
  GITHUB_DISCONNECTED_EVENT_TYPE,
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  integrationConnectionStreamPath,
} from "./utils.ts";

// In-memory STREAM namespace behind the mocked itxEnv: each stream is an
// append-only event list, read newest-first by streamEventsNewestFirst via
// runtimeState + getEvents.
const streamNetwork = vi.hoisted(() => {
  const streams = new Map<string, { offset: number; payload: unknown; type: string }[]>();
  const getEventsCalls: Array<{
    afterOffset?: number;
    beforeOffset?: number;
    eventTypes?: readonly string[];
    limit?: number;
  }> = [];
  return { getEventsCalls, streams };
});

// connect-flows imports slack-api (disconnect's auth.revoke) and telegram-api
// (disconnect's deleteWebhook), which drag the worker-only egress entrypoint
// into the module graph; sever those edges — these tests never touch either.
vi.mock("./slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));
vi.mock("./telegram-api.ts", () => ({
  callProjectTelegramBotApi: vi.fn(),
  telegramApiBaseUrl: (config: { integrations: { telegram: { apiBaseUrl: string } } }) =>
    config.integrations.telegram.apiBaseUrl.replace(/\/$/, ""),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    STREAM: {
      getByName(name: string) {
        const events = streamNetwork.streams.get(name) ?? [];
        streamNetwork.streams.set(name, events);
        return {
          async runtimeState() {
            return { coreProcessorState: { maxOffset: events.length } };
          },
          async getEvents(input: {
            afterOffset?: number;
            beforeOffset?: number;
            eventTypes?: readonly string[];
            limit?: number;
          }) {
            streamNetwork.getEventsCalls.push(input);
            const { afterOffset = 0, beforeOffset = Infinity, eventTypes, limit = 500 } = input;
            return events
              .filter(
                (event) =>
                  event.offset > afterOffset &&
                  event.offset < beforeOffset &&
                  (eventTypes === undefined || eventTypes.includes(event.type)),
              )
              .slice(0, limit);
          },
        };
      },
    },
  },
}));

const { getConnectionStatus } = await import("./connect-flows.ts");

function seed(
  projectId: string,
  connection: string,
  events: { payload: unknown; type: string }[],
  slug = "google",
) {
  const name = DurableObjectNameCodec.stringify({
    path: integrationConnectionStreamPath(slug, connection),
    projectId,
  });
  streamNetwork.streams.set(
    name,
    events.map((e, i) => ({ ...e, offset: i + 1 })),
  );
}

afterEach(() => {
  streamNetwork.getEventsCalls.length = 0;
  streamNetwork.streams.clear();
});

test("connection status filters lifecycle facts before reading a webhook-heavy journal", async () => {
  seed(
    "prj_1",
    "install-1",
    [
      {
        type: GITHUB_CONNECTED_EVENT_TYPE,
        payload: {
          connection: "install-1",
          externalId: "115079265",
          installationId: "115079265",
        },
      },
      ...Array.from({ length: 15_385 }, (_, index) => ({
        type: "events.iterate.com/github/webhook-received",
        payload: { index },
      })),
    ],
    "github",
  );

  expect(
    await getConnectionStatus({ connection: "install-1", projectId: "prj_1", provider: "github" }),
  ).toMatchObject({ connected: true, externalId: "115079265" });
  expect(streamNetwork.getEventsCalls).toEqual([
    {
      afterOffset: 0,
      eventTypes: [GITHUB_CONNECTED_EVENT_TYPE, GITHUB_DISCONNECTED_EVENT_TYPE],
      limit: 500,
    },
  ]);
});

describe("getConnectionStatus (google)", () => {
  test("connected fact yields display metadata (no tokens)", async () => {
    seed("prj_1", "jonas", [
      {
        type: GOOGLE_CONNECTED_EVENT_TYPE,
        payload: { email: "jonas@nustom.com", googleUserId: "g-1", name: "Jonas", scopes: ["a"] },
      },
    ]);
    expect(
      await getConnectionStatus({ connection: "jonas", projectId: "prj_1", provider: "google" }),
    ).toEqual({
      connected: true,
      displayName: "jonas@nustom.com",
      externalId: "g-1",
      metadata: {
        email: "jonas@nustom.com",
        name: "Jonas",
        picture: undefined,
        scopes: ["a"],
      },
    });
  });

  test("a later disconnected fact wins (no metadata on the disconnected fact)", async () => {
    seed("prj_1", "jonas", [
      { type: GOOGLE_CONNECTED_EVENT_TYPE, payload: { email: "jonas@nustom.com" } },
      { type: GOOGLE_DISCONNECTED_EVENT_TYPE, payload: {} },
    ]);
    expect(
      await getConnectionStatus({ connection: "jonas", projectId: "prj_1", provider: "google" }),
    ).toEqual({ connected: false, displayName: null, externalId: null, metadata: {} });
  });

  test("non-lifecycle events on top of the connected fact are skipped", async () => {
    seed("prj_1", "jonas", [
      { type: GOOGLE_CONNECTED_EVENT_TYPE, payload: { email: "jonas@nustom.com" } },
      { type: "events.iterate.com/google/token-refreshed", payload: {} },
    ]);
    expect(
      await getConnectionStatus({ connection: "jonas", projectId: "prj_1", provider: "google" }),
    ).toMatchObject({ connected: true, displayName: "jonas@nustom.com" });
  });

  test("no facts → not connected", async () => {
    expect(
      await getConnectionStatus({ connection: "nobody", projectId: "prj_1", provider: "google" }),
    ).toEqual({ connected: false, displayName: null, externalId: null, metadata: {} });
  });
});
