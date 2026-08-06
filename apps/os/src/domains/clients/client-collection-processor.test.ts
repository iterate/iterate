// The client collection's executable spec on the generic step harness: a pure
// projector, so scenarios are appends of copied client-stream facts plus
// assertions on the reduced roster. Connection facts come from the REAL core
// vocabulary (connection-opened/closed) — the discrimination under test is the
// openedBy `client` marker (a stream-viewer tab opening the same client
// stream must never appear in the roster) and the idle-vs-departed close
// distinction (idle is dormancy, not departure).

import { describe, expect, test, vi } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { CLIENT_COLLECTION_PATH } from "./client-collection-processor-contract.ts";
import { ClientCollectionProcessorContract } from "./client-collection-processor-contract.ts";
import { ClientCollectionStreamProcessor } from "./client-collection-processor-implementation.ts";

type CollectionEventInput = ConsumedInput<ClientCollectionProcessorContract>;

function makeCollectionHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<ClientCollectionProcessorContract>({
    createProcessor: (deps) => new ClientCollectionStreamProcessor(deps),
    path: CLIENT_COLLECTION_PATH,
    ...(substrate === undefined ? {} : { substrate }),
  });
}

const COLLECTION_CREATED = {
  type: "events.iterate.com/client-collection/created",
  payload: {},
} satisfies CollectionEventInput;

function copiedFromSource(type: string, path: string, sourceOffset: number) {
  return {
    copiedFrom: [
      {
        name: "client-collection",
        streamId: "11111111-1111-4111-8111-111111111111",
        streamCreatedAt: "2026-08-06T09:00:00.000Z",
        cursorChangedAtSourceOffset: 1,
        createdAt: new Date(
          Date.parse("2026-08-06T10:00:00.000Z") + sourceOffset * 1_000,
        ).toISOString(),
        offset: sourceOffset,
        path,
        projectId: "proj_harness",
        type,
      },
    ],
  };
}

function clientCreatedCopy(args: { sourceOffset: number; path?: string }): CollectionEventInput {
  const path = args.path ?? "/clients/chrome";
  return {
    type: "events.iterate.com/client/created",
    payload: { path },
    source: copiedFromSource("events.iterate.com/client/created", path, args.sourceOffset),
  };
}

function connectionOpenedCopy(args: {
  sourceOffset: number;
  path?: string;
  connectionKey?: string;
  openedBy?: unknown;
}): CollectionEventInput {
  const path = args.path ?? "/clients/chrome";
  return {
    type: "events.iterate.com/stream/connection-opened",
    payload: {
      connectionKey: args.connectionKey ?? "conn-1",
      kind: "session",
      ...(args.openedBy === undefined ? {} : { openedBy: args.openedBy }),
    },
    source: copiedFromSource(
      "events.iterate.com/stream/connection-opened",
      path,
      args.sourceOffset,
    ),
  } as CollectionEventInput;
}

function connectionClosedCopy(args: {
  sourceOffset: number;
  path?: string;
  connectionKey?: string;
  reason: string;
}): CollectionEventInput {
  const path = args.path ?? "/clients/chrome";
  return {
    type: "events.iterate.com/stream/connection-closed",
    payload: { connectionKey: args.connectionKey ?? "conn-1", reason: args.reason },
    source: copiedFromSource(
      "events.iterate.com/stream/connection-closed",
      path,
      args.sourceOffset,
    ),
  } as CollectionEventInput;
}

describe("ClientCollectionStreamProcessor", () => {
  test("reduces a client birth and a marked connection into the roster with source-time stamps", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      clientCreatedCopy({ sourceOffset: 2 }),
      connectionOpenedCopy({
        sourceOffset: 3,
        openedBy: { description: "Jonas's Chrome", client: { capabilities: true } },
      }),
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: {},
      clients: {
        "/clients/chrome": {
          path: "/clients/chrome",
          description: "Jonas's Chrome",
          createdAt: "2026-08-06T10:00:02.000Z",
          connections: {
            "conn-1": {
              openedAt: "2026-08-06T10:00:03.000Z",
              description: "Jonas's Chrome",
              hasCapabilities: true,
            },
          },
        },
      },
    });
  });

  test("an unmarked opener (a stream-viewer tab) never appears in the roster", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      clientCreatedCopy({ sourceOffset: 2 }),
      connectionOpenedCopy({
        sourceOffset: 3,
        connectionKey: "viewer",
        openedBy: { description: "browser" },
      }),
      connectionOpenedCopy({ sourceOffset: 4, connectionKey: "anonymous" }),
    ]);

    expect(h.state().clients["/clients/chrome"]?.connections).toEqual({});
  });

  test("idle marks a connection dormant; the wake re-dial clears it; departed removes it", async () => {
    const h = makeCollectionHarness();
    const openedBy = { description: "CLI", client: {} };
    await h.play([
      "append",
      COLLECTION_CREATED,
      clientCreatedCopy({ sourceOffset: 1 }),
      connectionOpenedCopy({ sourceOffset: 2, openedBy }),
      connectionClosedCopy({ sourceOffset: 3, reason: "idle" }),
    ]);
    expect(h.state().clients["/clients/chrome"]?.connections["conn-1"]).toMatchObject({
      dormant: true,
      hasCapabilities: false,
    });

    await h.play(["append", connectionOpenedCopy({ sourceOffset: 4, openedBy })]);
    expect(h.state().clients["/clients/chrome"]?.connections["conn-1"]?.dormant).toBeUndefined();

    await h.play(["append", connectionClosedCopy({ sourceOffset: 5, reason: "departed" })]);
    expect(h.state().clients["/clients/chrome"]?.connections).toEqual({});
    expect(h.state().clients["/clients/chrome"]?.lastDisconnectedAt).toBe(
      "2026-08-06T10:00:05.000Z",
    );
  });

  test("maxConnections eviction (fresh open, then oldest replaced) and a platform kick reduce cleanly", async () => {
    const h = makeCollectionHarness();
    const openedBy = { description: "Desk robot", client: { capabilities: true } };
    await h.play([
      "append",
      COLLECTION_CREATED,
      clientCreatedCopy({ sourceOffset: 1, path: "/clients/desk-robot" }),
      connectionOpenedCopy({
        sourceOffset: 2,
        path: "/clients/desk-robot",
        connectionKey: "conn-a",
        openedBy,
      }),
      // maxConnections: 1 — the DO publishes the fresh open FIRST, then
      // evicts the oldest as "replaced"; the roster must end at exactly one.
      connectionOpenedCopy({
        sourceOffset: 3,
        path: "/clients/desk-robot",
        connectionKey: "conn-b",
        openedBy,
      }),
      connectionClosedCopy({
        sourceOffset: 4,
        path: "/clients/desk-robot",
        connectionKey: "conn-a",
        reason: "replaced",
      }),
    ]);

    const record = h.state().clients["/clients/desk-robot"];
    expect(Object.keys(record?.connections ?? {})).toEqual(["conn-b"]);
    expect(record?.connections["conn-b"]?.openedAt).toBe("2026-08-06T10:00:03.000Z");

    await h.play([
      "append",
      connectionClosedCopy({
        sourceOffset: 5,
        path: "/clients/desk-robot",
        connectionKey: "conn-b",
        reason: "kicked",
      }),
    ]);
    expect(h.state().clients["/clients/desk-robot"]?.connections).toEqual({});
  });

  test("skips copies without provenance and duplicate births without wedging", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = makeCollectionHarness();
      await h.play(["append", COLLECTION_CREATED, COLLECTION_CREATED]);
      const beforeMalformed = h.state();

      await h.play([
        "append",
        { type: "events.iterate.com/client/created", payload: { path: "/clients/x" } },
      ]);
      expect(h.state()).toEqual(beforeMalformed);
      expect(consoleError).toHaveBeenCalledWith(
        "client collection skipped events.iterate.com/client/created: missing source-stream coordinates",
      );

      await h.play([
        "append",
        clientCreatedCopy({ sourceOffset: 2 }),
        clientCreatedCopy({ sourceOffset: 5 }),
      ]);
      expect(Object.keys(h.state().clients)).toEqual(["/clients/chrome"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a full replay reduces to the identical roster", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      clientCreatedCopy({ sourceOffset: 1 }),
      connectionOpenedCopy({
        sourceOffset: 2,
        openedBy: { description: "Chrome", client: { capabilities: true } },
      }),
      connectionClosedCopy({ sourceOffset: 3, reason: "departed" }),
    ]);

    const replay = makeCollectionHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(ClientCollectionProcessorContract),
    });
    await replay.settle(); // replays the whole stream from offset zero
    expect(replay.state()).toEqual(h.state());
  });
});
