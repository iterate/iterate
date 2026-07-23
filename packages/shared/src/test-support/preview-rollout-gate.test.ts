import { describe, expect, test, vi } from "vitest";
import {
  PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV,
  resolvePreviewRolloutWaitMs,
  waitForPreviewRolloutBeforeProjectCreation,
} from "./preview-rollout-gate.ts";

describe("preview rollout project-creation gate", () => {
  test("waits only for the remaining absolute rollout interval", async () => {
    const beforeWait = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const readyAtMs = Date.parse("2026-07-23T00:05:06.000Z");
    const environment = {
      [PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV]: String(readyAtMs),
    };

    expect(
      resolvePreviewRolloutWaitMs({
        environment,
        nowMs: Date.parse("2026-07-23T00:04:48.000Z"),
      }),
    ).toBe(18_000);

    await waitForPreviewRolloutBeforeProjectCreation({
      beforeWait,
      environment,
      log,
      nowMs: Date.parse("2026-07-23T00:04:48.000Z"),
      sleep,
    });

    expect(beforeWait).toHaveBeenCalledExactlyOnceWith(18_000);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(18_000);
    expect(log).toHaveBeenCalledWith(
      "[preview-rollout] project creation waits 18000ms until 2026-07-23T00:05:06.000Z",
    );
  });

  test("does not wait locally or after the absolute boundary", async () => {
    const beforeWait = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});
    await waitForPreviewRolloutBeforeProjectCreation({ beforeWait, environment: {}, sleep });
    await waitForPreviewRolloutBeforeProjectCreation({
      beforeWait,
      environment: { [PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV]: "1000" },
      nowMs: 1000,
      sleep,
    });

    expect(beforeWait).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  test.each(["tomorrow", "1.5", String(Number.MAX_SAFE_INTEGER + 1)])(
    "rejects malformed harness value %s",
    async (value) => {
      await expect(
        waitForPreviewRolloutBeforeProjectCreation({
          environment: { [PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV]: value },
        }),
      ).rejects.toThrow(PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV);
    },
  );
});
