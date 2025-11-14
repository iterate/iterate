import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchLogStreamer } from "./batch-http-log-streaming.ts";

type RecordedRequest = {
  url: string;
  body: unknown;
  headers?: HeadersInit;
};

const recordRequest = (input: RequestInfo | URL, init?: RequestInit): RecordedRequest => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const raw = init?.body ?? null;
  const body = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { url, body, headers: init?.headers };
};

describe("createBatchLogStreamer", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  test("complete-triggered flush followed by stop does not send a duplicate request", async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requests.push(recordRequest(input, init));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      flushIntervalMs: 200, // short interval to try and trigger races
      heartbeatIntervalMs: 1_000_000, // disable heartbeats
    });

    streamer.start();
    streamer.enqueue({ stream: "stdout", message: "final", complete: true });

    // Wait for the complete-triggered flush to occur (without manually calling flush)
    await vi.waitFor(() => {
      expect(requests.length).toBe(1);
    });
    // Immediately stop, which also calls flush internally
    await streamer.stop();

    // Only one network call should have been issued
    expect(requests.length).toBe(1);
    expect(((requests[0].body as any).logs ?? []).length).toBe(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch!;
  });

  test("flushes immediately when enqueue is called with complete: true", async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      heartbeatIntervalMs: 1_000_000_000, // effectively disable heartbeats in this test
    });

    streamer.enqueue({ stream: "stdout", message: "hello world", complete: true });

    await vi.waitFor(() => {
      expect(requests.length).toBe(1);
    });

    const body = requests[0].body as { logs: Array<any> };
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].message).toBe("hello world");
    expect(body.logs[0].seq).toBe(1);
    expect(body.logs[0].stream).toBe("stdout");
  });

  test("batches multiple enqueued logs into a single POST preserving order", async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      heartbeatIntervalMs: 1_000_000_000, // disable heartbeats to isolate batching behavior
    });

    streamer.enqueue({ stream: "stdout", message: "one" });
    streamer.enqueue({ stream: "stderr", message: "two" });
    streamer.enqueue({ stream: "stdout", message: "three" });

    await streamer.flush();

    expect(requests.length).toBe(1);
    const body = requests[0].body as { logs: Array<any> };
    expect(body.logs.map((l) => [l.seq, l.stream, l.message])).toMatchInlineSnapshot(`
      [
        [
          1,
          "stdout",
          "one",
        ],
        [
          2,
          "stderr",
          "two",
        ],
        [
          3,
          "stdout",
          "three",
        ],
      ]
    `);
  });

  test("retries when response is not ok and preserves log order", async () => {
    const requests: RecordedRequest[] = [];
    let attempt = 0;
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      attempt += 1;
      if (attempt === 1) {
        return new Response("server error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      heartbeatIntervalMs: 1_000_000_000, // disable heartbeats to focus on retry behavior
    });

    streamer.enqueue({ stream: "stdout", message: "A" });
    streamer.enqueue({ stream: "stderr", message: "B" });

    await streamer.flush(); // first attempt -> 500, requeue and stop
    await streamer.flush(); // second attempt -> 200, success

    expect(requests.length).toBe(2);
    const first = requests[0].body as { logs: Array<any> };
    const second = requests[1].body as { logs: Array<any> };

    // Same payload attempted twice; order preserved
    expect(first.logs.map((l) => l.message)).toEqual(["A", "B"]);
    expect(second.logs.map((l) => l.message)).toEqual(["A", "B"]);
    expect(second.logs.map((l) => l.seq)).toEqual([1, 2]);
  });

  test("sends heartbeats on interval with meta and no logs", async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      meta: { service: "unit-test" },
      flushIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });

    streamer.start();

    // Advance time so we cross two heartbeat intervals:
    // t=600ms (first heartbeat), t=1100ms (second heartbeat)
    await vi.advanceTimersByTimeAsync(1_200);

    await streamer.stop();

    expect(requests.length).toBe(2);
    expect(
      requests.map((r) => ({
        url: r.url,
        logsLength: (r.body as any).logs.length,
        service: (r.body as any).service,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "logsLength": 0,
          "service": "unit-test",
          "url": "https://example.test/logs",
        },
        {
          "logsLength": 0,
          "service": "unit-test",
          "url": "https://example.test/logs",
        },
      ]
    `);
  });

  test("does not send an immediate heartbeat right after a successful logs send", async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      flushIntervalMs: 500,
      heartbeatIntervalMs: 500,
    });

    streamer.start();
    streamer.enqueue({ stream: "stdout", message: "payload" });

    // Initial manual flush sends the logs
    await streamer.flush();
    expect(requests.length).toBe(1);
    expect(((requests[0].body as any).logs ?? []).length).toBe(1);

    // Advance exactly one flush interval; with the fix, we should NOT see a heartbeat yet
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.length).toBe(1);

    // After another interval (total 1000ms), heartbeat is allowed to fire
    await vi.advanceTimersByTimeAsync(500);
    expect(requests.length).toBe(2);
    expect(((requests[1].body as any).logs ?? []).length).toBe(0);

    await streamer.stop();
  });

  test("does not send a second POST within the same flush when new logs arrive mid-flight", async () => {
    const requests: RecordedRequest[] = [];
    // Block the first fetch until we explicitly release it
    let releaseFirst: (() => void) | null = null;
    const firstBlock = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn(async (input, init) => {
      requests.push(recordRequest(input, init));
      if (releaseFirst) {
        await firstBlock; // wait until test releases the first call
        releaseFirst = null;
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamer = createBatchLogStreamer({
      url: "https://example.test/logs",
      flushIntervalMs: 1_000_000, // effectively disable periodic flushes
      heartbeatIntervalMs: 1_000_000,
    });

    // Enqueue one log, then start a flush
    streamer.enqueue({ stream: "stdout", message: "first" });
    const flushPromise = streamer.flush();

    // While flush is in-flight, enqueue another log
    streamer.enqueue({ stream: "stdout", message: "second" });

    // Release the first request
    (releaseFirst as unknown as () => void)();
    await flushPromise;

    // Only one network request should occur for this flush call
    expect(requests.length).toBe(1);
    const firstBody = requests[0].body as any;
    expect(firstBody.logs.map((l: any) => l.message)).toEqual(["first"]);

    // A subsequent flush will send the second message
    await streamer.flush();
    expect(requests.length).toBe(2);
    const secondBody = requests[1].body as any;
    expect(secondBody.logs.map((l: any) => l.message)).toEqual(["second"]);

    await streamer.stop();
  });
});
