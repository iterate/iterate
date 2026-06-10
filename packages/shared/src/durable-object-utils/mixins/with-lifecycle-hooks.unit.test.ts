import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type InitialStateTestRoom,
  type InspectorTestRoom,
  type InitializeTestRoom as InitializeTestRoomInstance,
  type ListedRoom,
} from "../test-harness/initialize-fronting-worker.ts";
import {
  deriveDurableObjectNameFromStructuredName,
  getInitializedDoStub,
} from "./with-lifecycle-hooks.ts";

const testEnv = env as {
  DO_CATALOG: D1Database;
  INITIAL_STATE_ROOMS: DurableObjectNamespace<InitialStateTestRoom>;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  ROOMS: DurableObjectNamespace<InitializeTestRoomInstance>;
};

function roomInit(name: string, ownerUserId: string) {
  return {
    name: roomName(name, ownerUserId),
  };
}

function roomName(name: string, ownerUserId: string) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: {
      ownerUserId,
      testName: name,
    },
  });
}

function getRoom<TStub>(
  namespace: {
    getByName(name: string): TStub;
  },
  name: string,
  ownerUserId: string,
) {
  return namespace.getByName(roomName(name, ownerUserId));
}

describe("withLifecycleHooks", () => {
  it("initializes by name and exposes params through assertInitialized", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-a", "user-a");

    await expect(room.initialize(roomInit("unit-room-a", "user-a"))).resolves.toEqual({
      ownerUserId: "user-a",
    });
    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-a",
    });
  });

  it("supports the protected structuredName convenience in subclasses", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-message", "user-message");

    await room.initialize(roomInit("unit-room-message", "user-message"));

    await expect(room.sendMessage("hello")).resolves.toEqual({
      room: roomName("unit-room-message", "user-message"),
      ownerUserId: "user-message",
      text: "hello",
    });
  });

  it("throws synchronously from subclass code when not initialized", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-uninitialized");

    await expect(room.trySendMessage("hello")).resolves.toMatchObject({
      name: "NotInitializedError",
    });
  });

  it("keeps initialization idempotent for identical params", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-idempotent", "user-original");

    await room.initialize(roomInit("unit-room-idempotent", "user-original"));

    await expect(
      room.initialize(roomInit("unit-room-idempotent", "user-original")),
    ).resolves.toEqual({
      ownerUserId: "user-original",
    });
  });

  it("rejects a structured name that would address a different object", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-conflict", "user-original");

    await room.initialize(roomInit("unit-room-conflict", "user-original"));

    await expect(
      room.tryInitializeName(roomInit("unit-room-conflict", "user-replacement")),
    ).resolves.toMatchObject({ name: "InitializeNameMismatchError" });
  });

  it("rejects mismatched names", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-mismatch");

    await expect(
      room.tryInitializeName(roomInit("different-room-name", "user-a")),
    ).resolves.toMatchObject({
      name: "InitializeNameMismatchError",
    });
  });

  it("initializes through the free getInitializedDoStub helper", async () => {
    const room = await getInitializedDoStub({
      allowCreate: true,
      namespace: testEnv.ROOMS,
      name: {
        ownerUserId: "user-static",
      },
    });

    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-static",
    });
  });

  it("initializes from a deterministic name when callers omit the name", async () => {
    const room = await getInitializedDoStub({
      allowCreate: true,
      namespace: testEnv.ROOMS,
      name: {
        ownerUserId: "user-derived",
      },
    });

    await expect(room.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-derived",
    });
  });

  it("derives the same name regardless of init param object key order", () => {
    expect(
      deriveDurableObjectNameFromStructuredName({
        structuredName: { ownerUserId: "user-derived", projectId: "project-a" },
      }),
    ).toBe(
      deriveDurableObjectNameFromStructuredName({
        structuredName: { projectId: "project-a", ownerUserId: "user-derived" },
      }),
    );
  });

  it("rejects helper calls without a name", async () => {
    await expect(
      getInitializedDoStub({
        allowCreate: true,
        namespace: testEnv.ROOMS,
      } as never),
    ).rejects.toThrow("requires name");
  });

  it("keeps initialization idempotent across direct and helper initialization", async () => {
    const name = deriveDurableObjectNameFromStructuredName({
      structuredName: { ownerUserId: "user-order" },
    });
    const room = testEnv.ROOMS.getByName(name);

    await room.initialize({ name });

    await expect(
      getInitializedDoStub({
        allowCreate: true,
        namespace: testEnv.ROOMS,
        name: {
          ownerUserId: "user-order",
        },
      }).then((stub) => stub.getStructuredName()),
    ).resolves.toEqual({
      ownerUserId: "user-order",
    });
  });

  it("can look up an initialized stub without creating lifecycle state", async () => {
    const missing = await getInitializedDoStub({
      allowCreate: false,
      namespace: testEnv.LISTED_ROOMS,
      name: {
        ownerUserId: "user-lookup-missing",
      },
    });
    expect(missing).toBeNull();

    const created = await getInitializedDoStub({
      allowCreate: true,
      namespace: testEnv.LISTED_ROOMS,
      name: {
        ownerUserId: "user-lookup-existing",
      },
    });

    await expect(created.getStructuredName()).resolves.toEqual({
      ownerUserId: "user-lookup-existing",
    });

    await vi.waitFor(async () => {
      const existing = await getInitializedDoStub({
        allowCreate: false,
        namespace: testEnv.LISTED_ROOMS,
        name: {
          ownerUserId: "user-lookup-existing",
        },
      });

      expect(existing).not.toBeNull();
      await expect(existing!.getStructuredName()).resolves.toEqual({
        ownerUserId: "user-lookup-existing",
      });
    });
  });

  it("waits for registered lifecycle hooks before initialize returns", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-waits", "user-hook");

    await expect(room.initialize(roomInit("unit-room-hook-waits", "user-hook"))).resolves.toEqual({
      ownerUserId: "user-hook",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-hook",
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: true,
      instanceWakeFailedOnce: false,
    });
  });

  it("rejects ensureStarted before initialize has stored params", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-ensure-before-init");

    await expect(room.tryEnsureReady()).resolves.toMatchObject({
      kind: "error",
      name: "NotInitializedError",
    });
  });

  it("runs lifecycle hooks once for concurrent initialization attempts", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-concurrent-init", "user-concurrent");

    await expect(
      room.initializeTwiceConcurrently({
        ownerUserId: "user-concurrent",
      }),
    ).resolves.toEqual({
      results: [
        {
          ownerUserId: "user-concurrent",
        },
        {
          ownerUserId: "user-concurrent",
        },
      ],
      hookRuns: 1,
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
    });
  });

  it("retries instance wake hooks after a startup failure", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-fails-once", "user-fails-once");

    await expect(
      room.tryInitialize({
        ownerUserId: "user-fails-once",
      }),
    ).resolves.toMatchObject({
      kind: "error",
      name: "Error",
      message: "instance wake hook failed once",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
      instanceWakeFailedOnce: true,
    });

    await expect(
      room.initialize(roomInit("unit-room-hook-fails-once", "user-fails-once")),
    ).resolves.toEqual({
      ownerUserId: "user-fails-once",
    });

    await expect(room.getLifecycleHookState()).resolves.toEqual({
      firstInitializeRuns: 1,
      firstInitializeOwnerUserId: "user-fails-once",
      instanceWakeRuns: 2,
      instanceWakeStarted: true,
      instanceWakeFinished: true,
      instanceWakeFailedOnce: true,
    });
  });

  it("treats throw undefined from an instance wake hook as a real startup failure", async () => {
    const room = getRoom(testEnv.ROOMS, "unit-room-hook-throws-undefined", "user-throws-undefined");

    await expect(
      room.tryInitialize({
        ownerUserId: "user-throws-undefined",
      }),
    ).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 1,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
    });

    await expect(room.tryEnsureReady()).resolves.toEqual({
      kind: "error",
      name: "UnknownError",
      message: "undefined",
    });

    await expect(room.getLifecycleHookState()).resolves.toMatchObject({
      firstInitializeRuns: 1,
      instanceWakeRuns: 2,
      instanceWakeStarted: true,
      instanceWakeFinished: false,
    });
  });

  it("supports immutable initial state separate from the Durable Object name", async () => {
    const name = `initial-state-${crypto.randomUUID()}`;
    const room = await getInitializedDoStub({
      allowCreate: true,
      namespace: testEnv.INITIAL_STATE_ROOMS,
      name,
      initialState: {
        projectId: "project-initial",
        plan: "pro",
      },
    });

    await expect(room.getNameForTest()).resolves.toBe(name);
    await expect(room.getInitialStateForTest()).resolves.toEqual({
      projectId: "project-initial",
      plan: "pro",
    });

    await expect(room.initialize({ name })).resolves.toBe(name);
    await expect(room.getInitialStateForTest()).resolves.toEqual({
      projectId: "project-initial",
      plan: "pro",
    });
  });

  it("requires initial state the first time a stateful object is initialized", async () => {
    const name = `initial-state-required-${crypto.randomUUID()}`;
    const room = testEnv.INITIAL_STATE_ROOMS.getByName(name);

    await expect(room.tryInitialize({ name })).resolves.toMatchObject({
      name: "InitializeInitialStateRequiredError",
    });
  });

  it("rejects conflicting initial state for an already initialized object", async () => {
    const name = `initial-state-conflict-${crypto.randomUUID()}`;
    const room = testEnv.INITIAL_STATE_ROOMS.getByName(name);

    await room.initialize({
      name,
      initialState: {
        projectId: "project-original",
        plan: "free",
      },
    });

    await expect(
      room.tryInitialize({
        name,
        initialState: {
          projectId: "project-replacement",
          plan: "free",
        },
      }),
    ).resolves.toMatchObject({
      name: "InitializeInitialStateMismatchError",
    });
  });
});

describe("withOuterbase", () => {
  it("serves the embedded SQL inspector page and SQL endpoint", async () => {
    const inspector = testEnv.INSPECTORS.getByName("outerbase-unit");

    await inspector.seedSql();

    await expect(
      inspector.fetch("https://example.com/__outerbase").then((response) => response.text()),
    ).resolves.toContain("https://libsqlstudio.com/embed/sqlite");

    const response = await inspector.fetch("https://example.com/__outerbase/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statement: "SELECT text FROM messages WHERE id = ?",
        params: ["msg_1"],
      }),
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        rows: [{ text: "hello" }],
      },
    });
  });

  it("rejects SQL params that cannot be bound to Durable Object SQLite", async () => {
    const inspector = testEnv.INSPECTORS.getByName("outerbase-unit-bad-params");

    await inspector.seedSql();

    const response = await inspector.fetch("https://example.com/__outerbase/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statement: "SELECT text FROM messages WHERE id = ?",
        params: [{ id: "msg_1" }],
      }),
    });

    await expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "params entries must be strings, numbers, null, or ArrayBuffers.",
    });
  });
});

describe("withKvInspector", () => {
  it("pretty-prints Durable Object KV contents", async () => {
    const inspector = testEnv.INSPECTORS.getByName("kv-unit");

    await inspector.seedKv("hello", { nested: "world" });

    await expect(
      inspector.fetch("https://example.com/__kv/json").then((response) => response.json()),
    ).resolves.toEqual([{ key: "hello", value: { nested: "world" } }]);
    await expect(
      inspector.fetch("https://example.com/__kv").then((response) => response.text()),
    ).resolves.toContain("&quot;nested&quot;: &quot;world&quot;");
  });
});

describe("withLifecycleHooks D1 object catalog", () => {
  it("returns null when the object has not been initialized", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-uninitialized-unit");

    await expect(room.getD1ObjectCatalogRecord()).resolves.toBeNull();
  });

  it("returns JSON null through the fronting worker when no catalog record exists", async () => {
    const response = await SELF.fetch(
      "https://example.com/listed-rooms/listed-missing-unit/catalog",
    );

    await expect(response.json()).resolves.toBeNull();
  });

  it("best-effort writes initialized objects into D1", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-unit", "user-listed");

    await room.initialize(roomInit("listed-unit", "user-listed"));

    await vi.waitFor(async () => {
      await expect(room.getD1ObjectCatalogRecord()).resolves.toMatchObject({
        class: "ListedRoom",
        structuredName: {
          ownerUserId: "user-listed",
        },
      });
    });
  });

  it("creates the catalog table on first write", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-creates-table", "user-listed");

    await room.initialize(roomInit("listed-creates-table", "user-listed"));

    await vi.waitFor(async () => {
      await expect(
        testEnv.DO_CATALOG.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mixin_d1_object_catalog_objects'",
        ).first(),
      ).resolves.toEqual({
        name: "mixin_d1_object_catalog_objects",
      });
    });
  });

  it("indexes initialized objects by configured structured names", async () => {
    const room = getRoom(testEnv.LISTED_ROOMS, "listed-owner-index-unit", "user-indexed");

    await room.initialize(roomInit("listed-owner-index-unit", "user-indexed"));

    await vi.waitFor(async () => {
      const response = await SELF.fetch(
        "https://example.com/listed-rooms/by-owner-user-id/user-indexed",
      );

      await expect(response.json()).resolves.toMatchObject([
        {
          class: "ListedRoom",
          structuredName: {
            ownerUserId: "user-indexed",
          },
        },
      ]);
    });
  });
});
