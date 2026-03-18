import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRegistryClient } from "@iterate-com/registry-contract";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("registry streams integration", () => {
  test("append, list, and stream all work through the registry app", async () => {
    const fixture = await startRegistryStreamsFixture();
    cleanup = fixture.cleanup;

    await fixture.client.streams.append({
      path: "/test/stream",
      events: [
        {
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { msg: "hello" },
        },
      ],
    });

    const streams = await fixture.client.streams.list({});
    expect(streams.some((entry) => entry.path === "/test/stream")).toBe(true);

    const stream = await fixture.client.streams.stream({ path: "/test/stream", live: false });
    const event = await stream.next();
    await stream.return?.();

    expect(event.done).toBe(false);
    if (event.done) throw new Error("Expected a stream event");
    expect((event.value.payload as Record<string, unknown>).msg).toBe("hello");
  });

  test("first append creates exactly one meta stream event", async () => {
    const fixture = await startRegistryStreamsFixture();
    cleanup = fixture.cleanup;

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture.client.streams.append({
          path: "/test/concurrent",
          events: [
            {
              type: "https://events.iterate.com/events/test/concurrent-recorded",
              payload: { index },
            },
          ],
        }),
      ),
    );

    const stream = await fixture.client.streams.stream({ path: "/events/_meta", live: false });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    try {
      while (true) {
        const nextEvent = await stream.next();
        if (nextEvent.done) break;
        events.push({
          type: nextEvent.value.type,
          payload: nextEvent.value.payload as Record<string, unknown>,
        });
      }
    } finally {
      await stream.return?.();
    }

    const createdForTargetPath = events.filter(
      (event) =>
        event.type === "https://events.iterate.com/events/stream/created" &&
        event.payload.path === "test/concurrent",
    );

    expect(createdForTargetPath).toHaveLength(1);
  });
});

async function startRegistryStreamsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "registry-streams-"));
  const dbPath = join(directory, "registry.sqlite");

  process.env.REGISTRY_DB_PATH = dbPath;
  process.env.SYNC_TO_CADDY_PATH = "";

  vi.resetModules();

  const [{ default: app }, { resetRegistryContextForTests }, { disposeEventOperations }] =
    await Promise.all([
      import("./server/app.ts"),
      import("./server/context.ts"),
      import("./server/streams/singleton.ts"),
    ]);

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return await app.fetch(request);
  };

  const client = createRegistryClient({
    url: "http://registry.test",
    fetch: fetchImpl,
  });

  return {
    client,
    cleanup: async () => {
      await disposeEventOperations();
      await resetRegistryContextForTests();
      delete process.env.REGISTRY_DB_PATH;
      delete process.env.SYNC_TO_CADDY_PATH;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
