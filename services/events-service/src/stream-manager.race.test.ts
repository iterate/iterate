import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { Effect } from "effect";

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

          const attempts = Array.from({ length: concurrency }, (_, index) =>
            Effect.runPromise(
              manager.append({
                path,
                event: EventInput.make({
                  type: EventType.make("https://events.iterate.com/events/test/race"),
                  payload: { index },
                }),
              }),
            ).then(
              () => true,
              () => false,
            ),
          );

          const results = await Promise.all(attempts);
          expect(results.every(Boolean)).toBe(true);
        }
      } finally {
        await dispose();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
