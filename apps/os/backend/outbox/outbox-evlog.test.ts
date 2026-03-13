import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConsumerJobContext, QueuerEvent, ConsumerJobQueueMessage } from "./pgmq-lib.ts";

// --- Mocks ---------------------------------------------------------------

vi.mock("evlog", () => ({
  createRequestLogger: vi.fn(() => ({
    set: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    emit: vi.fn(),
    getContext: vi.fn(() => ({})),
  })),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockEvlogSet = vi.fn((..._args: any[]) => {});
const mockFlush = vi.fn((..._args: any[]) => {});
const mockRecordError = vi.fn((..._args: any[]) => {});
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock("../evlog.ts", () => ({
  withRequestEvlogContext: vi.fn((_opts: unknown, cb: () => unknown) => cb()),
  flushRequestEvlog: mockFlush,
  recordRequestEvlogError: mockRecordError,
  log: {
    set: mockEvlogSet,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    emit: vi.fn(),
    getContext: vi.fn(() => ({})),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendPostHogException = vi.fn((..._args: any[]) => Promise.resolve());

vi.mock("../lib/posthog.ts", () => ({
  sendPostHogException: mockSendPostHogException,
}));

vi.mock("../tag-logger.ts", () => ({
  logger: {
    set: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Helpers -------------------------------------------------------------

function makeJobCtx(overrides: Partial<ConsumerJobContext> = {}): ConsumerJobContext {
  return {
    consumerName: "testConsumer",
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
        consumer_name: "testConsumer",
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

// --- Tests ---------------------------------------------------------------

// Import after mocks are set up
const { createOutboxJobLifecycleHook, sendDLQToPostHog } = await import("./outbox-evlog.ts");
const { withRequestEvlogContext } = await import("../evlog.ts");
const { createRequestLogger } = await import("evlog");
const { logger: mockLogger } = await import("../tag-logger.ts");

describe("createOutboxJobLifecycleHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("successful job: calls run, sets status 200, flushes, returns outcome", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx();
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "done" }));

    const outcome = await hook(ctx, run);

    expect(run).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ ok: true, result: "done" });

    // evlog.set should record status 200 and result
    expect(mockEvlogSet).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ status: 200 }),
        outbox: expect.objectContaining({ status: "success", result: "done" }),
      }),
    );

    // Should NOT call recordRequestEvlogError for success
    expect(mockRecordError).not.toHaveBeenCalled();

    // Should always flush
    expect(mockFlush).toHaveBeenCalledOnce();
  });

  test("failed job: calls run, sets status 500, records error, flushes, returns outcome", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx();
    const error = new Error("handler exploded");
    const run = vi.fn(() => Promise.resolve({ ok: false as const, error }));

    const outcome = await hook(ctx, run);

    expect(run).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ ok: false, error });

    expect(mockEvlogSet).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ status: 500 }),
        outbox: expect.objectContaining({ status: "error" }),
      }),
    );

    // Should record the error with outbox context
    expect(mockRecordError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        outbox: expect.objectContaining({
          consumer: "testConsumer",
          jobId: 42,
          attempt: 1,
          eventName: "testing:poke",
          eventId: 100,
        }),
      }),
    );

    expect(mockFlush).toHaveBeenCalledOnce();
  });

  test("flushes even when evlog.set throws", async () => {
    mockEvlogSet.mockImplementationOnce(() => {
      throw new Error("evlog.set exploded");
    });

    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx();
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "ok" }));

    // The error from evlog.set propagates (it's inside try/finally, not try/catch)
    await expect(hook(ctx, run)).rejects.toThrow("evlog.set exploded");

    // But flush should still have been called (finally block)
    expect(mockFlush).toHaveBeenCalledOnce();
  });

  test("constructs correct requestId and path", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx({ consumerName: "myConsumer", jobId: 99, attempt: 3 });
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "ok" }));

    await hook(ctx, run);

    expect(createRequestLogger).toHaveBeenCalledWith({
      method: "OUTBOX",
      path: "outbox/myConsumer",
      requestId: "outbox:myConsumer:99:3",
    });
  });

  test("passes causation from eventContext.causedBy", async () => {
    const hook = createOutboxJobLifecycleHook();
    const causation = { eventId: 50, consumerName: "parentConsumer", jobId: 10 };
    const ctx = makeJobCtx({ eventContext: { causedBy: causation } });
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "ok" }));

    await hook(ctx, run);

    // The jobLogger.set call should include causation in outbox
    const mockLogger = vi.mocked(createRequestLogger).mock.results[0].value;
    expect(mockLogger.set).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({ causation }),
      }),
    );
  });

  test("omits causation when eventContext is null", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx({ eventContext: null });
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "ok" }));

    await hook(ctx, run);

    const mockLogger = vi.mocked(createRequestLogger).mock.results[0].value;
    const setCall = mockLogger.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setCall.outbox).not.toHaveProperty("causation");
  });

  test("passes env and request metadata to withRequestEvlogContext", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx({ consumerName: "myConsumer", jobId: 7, attempt: 2 });
    const run = vi.fn(() => Promise.resolve({ ok: true as const, result: "ok" }));

    await hook(ctx, run);

    const call = vi.mocked(withRequestEvlogContext).mock.calls[0][0];
    expect(call).toMatchObject({
      env: {
        VITE_APP_STAGE: expect.any(String),
      },
      request: {
        method: "OUTBOX",
        path: "outbox/myConsumer",
        requestId: "outbox:myConsumer:7:2",
      },
    });
    // env should always have the POSTHOG_PUBLIC_KEY key (even if undefined)
    expect(call.env).toHaveProperty("POSTHOG_PUBLIC_KEY");
  });

  test("result string is coerced via String()", async () => {
    const hook = createOutboxJobLifecycleHook();
    const ctx = makeJobCtx();
    const run = vi.fn(() =>
      Promise.resolve({ ok: true as const, result: undefined as unknown as string }),
    );

    await hook(ctx, run);

    expect(mockEvlogSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outbox: expect.objectContaining({ result: "undefined" }),
      }),
    );
  });
});

describe("sendDLQToPostHog", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, POSTHOG_PUBLIC_KEY: "phc_test123" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("sends exception to PostHog for DLQ events", () => {
    const event = makeQueuerEvent();

    sendDLQToPostHog(event);

    expect(mockSendPostHogException).toHaveBeenCalledOnce();
    expect(mockSendPostHogException).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "phc_test123",
        distinctId: "system:outbox",
        lib: "outbox-dlq",
        errors: [
          expect.objectContaining({
            message: "boom",
            name: "OutboxDLQ:testConsumer",
          }),
        ],
        request: expect.objectContaining({
          method: "OUTBOX",
          path: "outbox/testConsumer",
          status: 500,
        }),
        user: expect.objectContaining({
          id: "system:outbox",
          email: "outbox@system",
        }),
        properties: expect.objectContaining({
          outbox: expect.objectContaining({
            consumer: "testConsumer",
            jobId: 42,
            attempt: 5,
            eventName: "testing:poke",
            eventId: 100,
          }),
        }),
      }),
    );
  });

  test("skips when isDLQ is false", () => {
    sendDLQToPostHog(makeQueuerEvent({ isDLQ: false }));
    expect(mockSendPostHogException).not.toHaveBeenCalled();
  });

  test("skips when isDLQ is undefined", () => {
    sendDLQToPostHog(makeQueuerEvent({ isDLQ: undefined }));
    expect(mockSendPostHogException).not.toHaveBeenCalled();
  });

  test("skips when error is falsy", () => {
    sendDLQToPostHog(makeQueuerEvent({ error: undefined }));
    expect(mockSendPostHogException).not.toHaveBeenCalled();
  });

  test("skips when no POSTHOG_PUBLIC_KEY env var", () => {
    delete process.env.POSTHOG_PUBLIC_KEY;
    delete process.env.VITE_POSTHOG_PUBLIC_KEY;

    sendDLQToPostHog(makeQueuerEvent());
    expect(mockSendPostHogException).not.toHaveBeenCalled();
  });

  test("falls back to VITE_POSTHOG_PUBLIC_KEY", () => {
    delete process.env.POSTHOG_PUBLIC_KEY;
    process.env.VITE_POSTHOG_PUBLIC_KEY = "phc_vite_key";

    sendDLQToPostHog(makeQueuerEvent());

    expect(mockSendPostHogException).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "phc_vite_key" }),
    );
  });

  test("extracts causation from event_context", () => {
    const causation = { eventId: 50, consumerName: "parent", jobId: 10 };
    const event = makeQueuerEvent();
    (event.job.message.event_context as Record<string, unknown>) = { causedBy: causation };

    sendDLQToPostHog(event);

    expect(mockSendPostHogException).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          outbox: expect.objectContaining({ causation }),
        }),
      }),
    );
  });

  test("causation is null when event_context has no causedBy", () => {
    const event = makeQueuerEvent();
    event.job.message.event_context = {};

    sendDLQToPostHog(event);

    expect(mockSendPostHogException).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          outbox: expect.objectContaining({ causation: null }),
        }),
      }),
    );
  });

  test("catches and logs sendPostHogException failures", async () => {
    mockSendPostHogException.mockRejectedValueOnce(new Error("posthog down"));

    sendDLQToPostHog(makeQueuerEvent());

    // Give the .catch handler time to run
    await vi.waitFor(() => {
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[outbox] PostHog DLQ exception dispatch failed",
        expect.any(Error),
      );
    });
  });
});
