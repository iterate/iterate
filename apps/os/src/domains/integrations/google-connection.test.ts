// Unit tests for getConnectionStatus's google behavior — the newest-first
// lifecycle fold over the connection journal. Tokens never live on the journal
// (they're in the connection secret, refreshed by the Secret DO's shared
// oauth-refresh-token strategy), so status is display metadata only. Same
// in-memory itxEnv seam as github-connect.test.ts.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  integrationConnectionStreamPath,
} from "./utils.ts";

// In-memory STREAM namespace behind the mocked itxEnv: each stream is an
// append-only event list, read newest-first by streamEventsNewestFirst via
// runtimeState + getEvents.
const streamNetwork = vi.hoisted(() => {
  const streams = new Map<string, { offset: number; payload: unknown; type: string }[]>();
  return { streams };
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
          async getEvents({ afterOffset = 0, beforeOffset = Infinity }) {
            return events.filter((e) => e.offset > afterOffset && e.offset < beforeOffset);
          },
        };
      },
    },
  },
}));

const { getConnectionStatus } = await import("./connect-flows.ts");

function seed(projectId: string, connection: string, events: { payload: unknown; type: string }[]) {
  const name = DurableObjectNameCodec.stringify({
    path: integrationConnectionStreamPath("google", connection),
    projectId,
  });
  streamNetwork.streams.set(
    name,
    events.map((e, i) => ({ ...e, offset: i + 1 })),
  );
}

afterEach(() => streamNetwork.streams.clear());

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
