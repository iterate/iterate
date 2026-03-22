import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "../logging/index.ts";
import { captureServerEvent, sendLogExceptionToPostHog } from "./posthog.ts";

describe("posthog egress overrides", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("captureServerEvent respects request-scoped egress override", async () => {
    await logger.run(async () => {
      logger.set({
        egress: {
          ["https://eu.i.posthog.com"]: "http://127.0.0.1:43111",
        },
      });

      await captureServerEvent(
        { POSTHOG_PUBLIC_KEY: "ph_test", VITE_APP_STAGE: "test" },
        { distinctId: "usr_1", event: "something_happened" },
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43111/capture/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("sendLogExceptionToPostHog respects nested parent egress override", async () => {
    await logger.run(async () => {
      logger.set({
        egress: {
          ["https://eu.i.posthog.com"]: "http://127.0.0.1:43112",
        },
      });

      await sendLogExceptionToPostHog({
        env: { POSTHOG_PUBLIC_KEY: "ph_test", VITE_APP_STAGE: "test" },
        log: {
          meta: { id: "log_child", start: "2026-01-01T00:00:00.000Z", durationMs: 1 },
          errors: [{ name: "Error", message: "boom" }],
          parent: {
            meta: { id: "log_parent", start: "2026-01-01T00:00:00.000Z" },
            request: { id: "req_1", method: "GET", path: "/x", status: 500 },
          },
        },
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43112/capture/",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
