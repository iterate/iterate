import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { disposeEventOperations, getEventOperations } from "../effect-stream-manager/singleton.ts";

describe("Event operations singleton recovery", () => {
  test("transient startup failure does not poison later retries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "events-singleton-recovery-"));
    const blockedDbPath = join(tempDir, "events.sqlite");
    await mkdir(blockedDbPath);

    const env = {
      PORT: 17320,
      DATABASE_URL: blockedDbPath,
      ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 30_000,
    };

    try {
      await expect(getEventOperations(env)).rejects.toBeDefined();

      await rm(blockedDbPath, { recursive: true, force: true });

      const operations = await getEventOperations(env);
      expect(operations).toBeDefined();
      expect(typeof operations.appendEvents).toBe("function");
    } finally {
      await disposeEventOperations(env);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
