import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendDevLogFile,
  clearBufferedLogEvents,
  getBufferedLogEvents,
  logger,
  recordBufferedLog,
  shouldKeepLogEvent,
  writeJsonLog,
  writePrettyLog,
} from "./index.ts";
import { createOutboxJobLifecycleHook, sendDLQToPostHog } from "../outbox/outbox-logging.ts";
import type {
  ConsumerJobContext,
  ConsumerJobQueueMessage,
  QueuerEvent,
} from "../outbox/pgmq-lib.ts";

const { mockSendPostHogException } = vi.hoisted(() => ({
  mockSendPostHogException: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("../lib/posthog.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/posthog.ts")>("../lib/posthog.ts");
  return {
    ...actual,
    sendPostHogException: mockSendPostHogException,
  };
});

function makeJobCtx(overrides: Partial<ConsumerJobContext> = {}): ConsumerJobContext {
  return {
    consumerName: "test-consumer",
    jobId: 42,
    attempt: 1,
    eventName: "testing:poke",
    eventId: 100,
    eventContext: null,
    ...overrides,
  };
}

function makeQueuerEvent(overrides: Partial<QueuerEvent> = {}): QueuerEvent {
  return {
    job: {
      msg_id: 42,
      enqueued_at: "2026-01-01T00:00:00Z",
      vt: "2026-01-01T00:01:00Z",
      read_ct: 5,
      message: {
        event_name: "testing:poke",
        consumer_name: "test-consumer",
        event_id: 100,
        event_payload: {},
        event_context: null,
        processing_results: ["#1 success: ok", "#2 error: boom"],
        environment: "test",
        status: "failed",
      },
    } as ConsumerJobQueueMessage,
    error: "boom",
    isDLQ: true,
    ...overrides,
  };
}

describe("logging", () => {
  let cleanupHandlers: Array<() => void> = [];

  beforeEach(() => {
    delete process.env.LOG_KEEP;
    delete process.env.EVLOG_KEEP;
    clearBufferedLogEvents();
    cleanupHandlers = [logger.onExit(recordBufferedLog)];
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupHandlers.forEach((cleanup) => cleanup());
    delete process.env.LOG_KEEP;
    delete process.env.EVLOG_KEEP;
    delete process.env.POSTHOG_PUBLIC_KEY;
    delete process.env.VITE_POSTHOG_PUBLIC_KEY;
    vi.useRealTimers();
  });

  test("builds one wide event with request + meta + formatted messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await logger.run(async () => {
      logger.set({
        service: "os",
        environment: "test",
        request: { id: "req_123", method: "GET", path: "/api/test", status: 500 },
        user: { id: "anonymous", email: "unknown" },
      });
      vi.advanceTimersByTime(300);
      logger.info("user logged in");
      logger.set({
        request: { status: 200 },
        user: { id: "usr_123", email: "x@y.com" },
      });
      vi.advanceTimersByTime(200);
    });

    const [event] = getBufferedLogEvents();
    expect(event.meta.start).toBe("2026-01-01T00:00:00.000Z");
    expect(event.meta.end).toBe("2026-01-01T00:00:00.500Z");
    expect(event.meta.durationMs).toBe(500);
    expect(event.request).toEqual({ id: "req_123", method: "GET", path: "/api/test", status: 200 });
    expect(event.messages).toEqual(["[INFO] 0.3s: user logged in"]);
  });

  test("records errors as structured errors plus formatted error messages", async () => {
    await logger.run(async () => {
      logger.set({
        service: "os",
        environment: "test",
        request: { id: "req_456", method: "POST", path: "/api/fail", status: 500 },
      });
      logger.error("boom while processing", new Error("kaboom"), { feature: "checkout" });
    });

    const [event] = getBufferedLogEvents();
    expect(event.errors).toEqual([expect.objectContaining({ name: "Error", message: "kaboom" })]);
    expect(event.messages).toEqual([expect.stringContaining("[ERROR] ")]);
    expect(event.feature).toBe("checkout");
  });

  test("outbox jobs emit one event with outbox-owned context", async () => {
    const hook = createOutboxJobLifecycleHook();

    const outcome = await hook(
      makeJobCtx({
        eventContext: { causedBy: { eventId: 50, consumerName: "parent", jobId: 10 } },
      }),
      async () => ({ ok: true as const, result: "done" }),
    );

    expect(outcome).toEqual({ ok: true, result: "done" });

    const [event] = getBufferedLogEvents();
    expect(event.request).toEqual(
      expect.objectContaining({
        id: "outbox:test-consumer:42:1",
        method: "OUTBOX",
        path: "outbox/test-consumer",
        status: 200,
      }),
    );
    expect(event.outbox).toEqual(
      expect.objectContaining({
        consumerName: "test-consumer",
        eventName: "testing:poke",
        status: "success",
        result: "done",
        causation: { eventId: 50, consumerName: "parent", jobId: 10 },
      }),
    );
  });

  test("dlq forwarding uses outbox payload", async () => {
    process.env.POSTHOG_PUBLIC_KEY = "ph_test";
    mockSendPostHogException.mockResolvedValue(undefined);

    sendDLQToPostHog(makeQueuerEvent());
    await Promise.resolve();

    expect(mockSendPostHogException).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "ph_test",
        distinctId: "system:outbox",
        request: expect.objectContaining({ method: "OUTBOX", path: "outbox/test-consumer" }),
        properties: expect.objectContaining({
          outbox: expect.objectContaining({
            consumerName: "test-consumer",
            processingResults: ["#1 success: ok", "#2 error: boom"],
          }),
        }),
      }),
    );
  });

  test("legacy EVLOG_KEEP is rejected", () => {
    process.env.EVLOG_KEEP = "true";
    expect(() =>
      shouldKeepLogEvent({ meta: { id: "x", start: "", end: "", durationMs: 0 } }),
    ).toThrow(/EVLOG_KEEP is no longer supported/);
  });

  test("logging helpers are opt-in", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = {
      meta: {
        id: "log_test",
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T00:00:00.100Z",
        durationMs: 100,
      },
      service: "os",
      environment: "test",
      request: { id: "req_1", method: "GET", path: "/x", status: 200 },
    };

    writeJsonLog(log);
    writePrettyLog(log);
    await appendDevLogFile(log);

    expect(stdoutWrite).toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalled();
  });

  test("logging outside logger.run is illegal", () => {
    expect(() => logger.set({ foo: "bar" })).toThrow(/illegal/);
    expect(() => logger.info("hi")).toThrow(/illegal/);
  });
});
