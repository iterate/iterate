import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getInitializedDoStub } from "./initialize.ts";
import {
  type InspectorTestRoom,
  type InitializeTestRoom as InitializeTestRoomInstance,
  type ListedRoom,
} from "../test-harness/initialize-fronting-worker.ts";

const testEnv = env as {
  DO_LISTINGS: D1Database;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  ROOMS: DurableObjectNamespace<InitializeTestRoomInstance>;
};

describe("withInitialize", () => {
  it("initializes by name and exposes params through assertInitialized", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-a");

    await expect(room.initialize({ name: "unit-room-a", ownerUserId: "user-a" })).resolves.toEqual({
      name: "unit-room-a",
      ownerUserId: "user-a",
    });
    await expect(room.getInitParams()).resolves.toEqual({
      name: "unit-room-a",
      ownerUserId: "user-a",
    });
  });

  it("supports the protected initParams convenience in subclasses", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-message");

    await room.initialize({ name: "unit-room-message", ownerUserId: "user-message" });

    await expect(room.sendMessage("hello")).resolves.toEqual({
      room: "unit-room-message",
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
    const room = testEnv.ROOMS.getByName("unit-room-idempotent");

    await room.initialize({ name: "unit-room-idempotent", ownerUserId: "user-original" });

    await expect(
      room.initialize({ name: "unit-room-idempotent", ownerUserId: "user-original" }),
    ).resolves.toEqual({
      name: "unit-room-idempotent",
      ownerUserId: "user-original",
    });
  });

  it("rejects conflicting params for an already initialized object", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-conflict");

    await room.initialize({ name: "unit-room-conflict", ownerUserId: "user-original" });

    await expect(
      room.tryInitialize({ name: "unit-room-conflict", ownerUserId: "user-replacement" }),
    ).resolves.toMatchObject({
      name: "InitializeParamsMismatchError",
    });
  });

  it("rejects mismatched names", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-mismatch");

    await expect(
      room.tryInitialize({ name: "different-room", ownerUserId: "user-a" }),
    ).resolves.toMatchObject({
      name: "InitializeNameMismatchError",
    });
  });

  it("initializes through the free getInitializedDoStub helper", async () => {
    const room = await getInitializedDoStub({
      namespace: testEnv.ROOMS,
      name: "unit-room-helper",
      initParams: {
        ownerUserId: "user-static",
      },
    });

    await expect(room.getInitParams()).resolves.toEqual({
      name: "unit-room-helper",
      ownerUserId: "user-static",
    });
  });

  it("keeps initialization idempotent across direct and helper initialization", async () => {
    const room = testEnv.ROOMS.getByName("unit-room-order");

    await room.initialize({ name: "unit-room-order", ownerUserId: "user-order" });

    await expect(
      getInitializedDoStub({
        namespace: testEnv.ROOMS,
        name: "unit-room-order",
        initParams: {
          ownerUserId: "user-order",
        },
      }).then((stub) => stub.getInitParams()),
    ).resolves.toEqual({
      name: "unit-room-order",
      ownerUserId: "user-order",
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

describe("withExternalListing", () => {
  it("best-effort writes initialized objects into D1", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-unit");

    await room.initialize({ name: "listed-unit", ownerUserId: "user-listed" });

    await expect(room.getExternalListing()).resolves.toMatchObject({
      class: "ListedRoom",
      name: "listed-unit",
      initParams: {
        name: "listed-unit",
        ownerUserId: "user-listed",
      },
    });
  });

  it("creates the listing table on first write", async () => {
    const room = testEnv.LISTED_ROOMS.getByName("listed-creates-table");

    await room.initialize({
      name: "listed-creates-table",
      ownerUserId: "user-listed",
    });

    await expect(
      testEnv.DO_LISTINGS.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mixin_external_listing'",
      ).first(),
    ).resolves.toEqual({
      name: "mixin_external_listing",
    });
  });
});
