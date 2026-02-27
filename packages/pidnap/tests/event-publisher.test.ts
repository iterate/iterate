import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventPublisher } from "../src/event-publisher.ts";
import { createMockLogger } from "./test-utils.ts";

describe("EventPublisher", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("publishes event in stream append shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const publisher = new EventPublisher(
      {
        callbackURL: "http://example.com/api/streams/pidnap",
      },
      createMockLogger(),
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker", previousState: "idle", state: "running" },
    });

    await publisher.close(2000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.com/api/streams/pidnap");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as {
      events: Array<{
        type: string;
        version?: string | number;
        payload: Record<string, unknown>;
      }>;
    };

    expect(body.events[0]?.type).toBe("https://events.iterate.com/pidnap/process/state-changed");
    expect(body.events[0]?.version).toBe("1");
    expect(body.events[0]?.payload.name).toBe("worker");
    expect(body.events[0]?.payload.eventId).toEqual(expect.any(String));
    expect(body.events[0]?.payload.emittedAt).toEqual(expect.any(String));
    expect(body.events[0]?.payload.sequence).toBe(1);
  });

  it("logs warning when callback returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const logger = createMockLogger();
    const publisher = new EventPublisher(
      {
        callbackURL: "http://example.com/api/streams/pidnap",
        retryMaxAttempts: 1,
      },
      logger,
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker", previousState: "running", state: "stopped" },
    });

    await publisher.close(2000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("retries and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const publisher = new EventPublisher(
      {
        callbackURL: "http://example.com/api/streams/pidnap",
        retryBaseDelayMs: 5,
        retryMaxDelayMs: 5,
        retryMaxAttempts: 5,
      },
      createMockLogger(),
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker", previousState: "idle", state: "running" },
    });

    await publisher.close(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops retrying old inflight events after close timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const publisher = new EventPublisher(
      {
        callbackURL: "http://example.com/api/streams/pidnap",
        retryBaseDelayMs: 5,
        retryMaxDelayMs: 5,
      },
      createMockLogger(),
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker", previousState: "idle", state: "running" },
    });

    await publisher.close(20);
    const attemptsWhenClosed = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(attemptsWhenClosed);
  });

  it("does nothing when callback URL is blank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const publisher = new EventPublisher(
      {
        callbackURL: "   ",
      },
      createMockLogger(),
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker", previousState: "idle", state: "running" },
    });

    await publisher.close(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can publish again after close", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const publisher = new EventPublisher(
      {
        callbackURL: "http://example.com/api/streams/pidnap",
      },
      createMockLogger(),
    );

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker-1" },
    });
    await publisher.close(2000);

    publisher.publish({
      type: "pidnap/process/state-changed",
      payload: { name: "worker-2" },
    });
    await publisher.close(2000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
