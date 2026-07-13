import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WIDE_LOG_BYTES, runWideLog, wideLogger, type WideLogEvent } from "./wide-log.ts";
import { runHttpWideLog } from "./operation.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLogs() {
  const events: WideLogEvent[] = [];
  vi.spyOn(console, "log").mockImplementation((event) => void events.push(event as WideLogEvent));
  vi.spyOn(console, "error").mockImplementation((event) => void events.push(event as WideLogEvent));
  return events;
}

describe("wide logs", () => {
  it("emits one typed event for a successful operation", async () => {
    const events = captureLogs();

    await expect(
      runWideLog({ kind: "test" }, async () => {
        wideLogger.set({ ingress: { lane: "api", transport: "websocket" } });
        wideLogger.info("started");
        return 42;
      }),
    ).resolves.toBe(42);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema: "iterate.wide-log.v1",
      message: "test",
      outcome: "ok",
      ingress: { lane: "api", transport: "websocket" },
      messages: [{ level: "info", message: "started" }],
      log: { kind: "test" },
    });
    expect(events[0]!.log.id).toMatch(/^log_/);
  });

  it("records only error structure and rethrows the original object", async () => {
    const events = captureLogs();
    const failure = new Error("token=worker-secret", { cause: new Error("private prompt") });
    failure.name = "also-a-secret";

    await expect(runWideLog({ kind: "test" }, async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(events[0]).toMatchObject({
      outcome: "error",
      error: { name: "Error", cause: { name: "Error" } },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/worker-secret|private prompt|also-a-secret/);
  });

  it("links nested operations without copying the parent payload", async () => {
    const events = captureLogs();

    await runWideLog({ kind: "parent", fields: { ingress: { lane: "api" } } }, () =>
      runWideLog({ kind: "child" }, async () => undefined),
    );

    const parent = events.find((event) => event.log.kind === "parent")!;
    const child = events.find((event) => event.log.kind === "child")!;
    expect(child.log.parentId).toBe(parent.log.id);
    expect(child.ingress).toBeUndefined();
  });

  it("bounds messages and the final event", async () => {
    const events = captureLogs();

    await runWideLog({ kind: "test" }, async () => {
      for (let index = 0; index < 30; index++) wideLogger.info(`message.${index}`);
      wideLogger.set({ ingress: { lane: "api", appSlug: "x".repeat(10_000) } });
    });

    expect(new TextEncoder().encode(JSON.stringify(events[0])).byteLength).toBeLessThanOrEqual(
      MAX_WIDE_LOG_BYTES,
    );
    expect(events[0]!.dropped).toMatchObject({ eventBytes: expect.any(Number) });
  });

  it("keeps logging failures out of the product result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console unavailable");
    });

    await expect(runWideLog({ kind: "test" }, async () => "result")).resolves.toBe("result");
  });

  it("rejects logging outside an operation", () => {
    expect(() => wideLogger.info("orphan")).toThrow("outside runWideLog");
  });
});

describe("HTTP operation logs", () => {
  it.each([
    [200, "ok"],
    [404, "client_error"],
    [503, "server_error"],
  ])("emits status %s without sampling", async (status, outcome) => {
    const events = captureLogs();

    await runHttpWideLog(async () => Promise.resolve(new Response(null, { status })));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome, message: "http_request" });
  });
});
