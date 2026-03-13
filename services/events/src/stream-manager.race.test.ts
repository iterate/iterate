import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";

import { EventInput, EventType, StreamPath } from "../effect-stream-manager/domain.ts";
import { effectEventStreamManager } from "../effect-stream-manager/runtime.ts";

describe("StreamManager race safety", () => {
  test("concurrent first appends on new paths do not collide on offset", async () => {
    // Regression for https://github.com/iterate/iterate/pull/1102
    const tempDir = await mkdtemp(join(tmpdir(), "events-stream-race-"));
    const databasePath = join(tempDir, "events.sqlite");

    try {
      const { manager, dispose } = await effectEventStreamManager({
        env: {
          DATABASE_URL: databasePath,
          ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 30_000,
        },
      });

      try {
        const rounds = 40;
        const concurrency = 24;

        for (let round = 0; round < rounds; round += 1) {
          const path = StreamPath.make(`race-${String(round)}`);
          let releaseStart: (() => void) | undefined;
          const start = new Promise<void>((resolve) => {
            releaseStart = resolve;
          });

          const attempts = Array.from({ length: concurrency }, (_, index) =>
            (async () => {
              await start;
              return Effect.runPromise(
                manager.append({
                  path,
                  event: EventInput.make({
                    type: EventType.make("https://events.iterate.com/events/test/race"),
                    payload: { index },
                  }),
                }),
              );
            })(),
          );
          releaseStart?.();

          const results = await Promise.allSettled(attempts);
          const failures = results.flatMap((result, index) =>
            result.status === "rejected"
              ? [`round=${String(round)} index=${String(index)} ${String(result.reason)}`]
              : [],
          );
          expect(failures).toEqual([]);

          const storedEvents = Array.from(
            await Effect.runPromise(Stream.runCollect(manager.read({ path }))),
          );
          expect(storedEvents.length).toBe(concurrency);

          const expectedOffsets = Array.from({ length: concurrency }, (_, index) =>
            String(index).padStart(16, "0"),
          );
          const actualOffsets = storedEvents.map((event) => String(event.offset));
          expect(actualOffsets).toEqual(expectedOffsets);
        }
      } finally {
        await dispose();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
