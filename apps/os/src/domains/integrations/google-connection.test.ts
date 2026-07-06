// Unit test for the Google connection metadata fold (v6). Replaces the old
// google-tokens.test.ts: tokens no longer live on the journal (they're in the
// connection secret, refreshed by the shared OAuth worker), so this only checks
// the newest-first lifecycle fold for display/status.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  integrationConnectionStreamPath,
} from "./utils.ts";

// In-memory STREAM namespace behind the mocked itxEnv (same seam the deleted
// google-tokens tests used): each stream is an append-only event list, read
// newest-first by streamEventsNewestFirst via runtimeState + getEvents.
const streamNetwork = vi.hoisted(() => {
  const streams = new Map<string, { offset: number; payload: unknown; type: string }[]>();
  return { streams };
});

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

const { readGoogleConnectionState } = await import("./google-connection.ts");

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

describe("readGoogleConnectionState", () => {
  test("connected fact yields display metadata (no tokens)", async () => {
    seed("prj_1", "jonas", [
      {
        type: GOOGLE_CONNECTED_EVENT_TYPE,
        payload: { email: "jonas@nustom.com", googleUserId: "g-1", name: "Jonas", scopes: ["a"] },
      },
    ]);
    expect(await readGoogleConnectionState("prj_1", "jonas")).toEqual({
      connected: true,
      email: "jonas@nustom.com",
      googleUserId: "g-1",
      name: "Jonas",
      picture: undefined,
      scopes: ["a"],
    });
  });

  test("a later disconnected fact wins", async () => {
    seed("prj_1", "jonas", [
      { type: GOOGLE_CONNECTED_EVENT_TYPE, payload: { email: "jonas@nustom.com" } },
      { type: GOOGLE_DISCONNECTED_EVENT_TYPE, payload: {} },
    ]);
    expect(await readGoogleConnectionState("prj_1", "jonas")).toEqual({ connected: false });
  });

  test("no facts → not connected", async () => {
    expect(await readGoogleConnectionState("prj_1", "nobody")).toEqual({ connected: false });
  });
});
