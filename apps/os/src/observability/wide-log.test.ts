import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WIDE_LOG_BYTES, runWideLog, wideLogger, type WideLogEvent } from "./wide-log.ts";
import { runHttpWideLog } from "./operation.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wide logs", () => {
  it("emits one accumulated event for a successful operation", async () => {
    const events: WideLogEvent[] = [];

    const result = await runWideLog(
      {
        kind: "test",
        fields: { service: "os" },
        sinks: [(event) => void events.push(event)],
      },
      async () => {
        wideLogger.set({ outcome: "set-outcome", log: { id: "set-id" } });
        wideLogger.set({ project: { id: "prj_123" } });
        wideLogger.info("started");
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema: "iterate.wide-log.v1",
      service: "os",
      project: { id: "prj_123" },
      outcome: "ok",
      messages: [{ level: "info", message: "started" }],
      log: {
        kind: "test",
      },
    });
    expect(events[0]!.log.id).toMatch(/^log_/);
    expect(events[0]!.log.id).not.toBe("set-id");
    expect(events[0]!.log.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records an error once and rethrows the original object", async () => {
    const events: WideLogEvent[] = [];
    const originals: unknown[][] = [];
    const failure = Object.assign(
      new Error("token=worker-secret", { cause: new Error("prompt") }),
      {
        code: "OUTER_FAILURE",
      },
    );

    await expect(
      runWideLog(
        {
          kind: "test",
          sinks: [
            (event, context) => {
              events.push(event);
              originals.push([...context.originalErrors]);
            },
          ],
        },
        async () => {
          wideLogger.error(failure);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(events[0]).toMatchObject({
      outcome: "error",
      errors: [{ name: "Error", code: "OUTER_FAILURE", cause: { name: "Error" } }],
    });
    expect(events[0]!.errors).toHaveLength(1);
    expect(originals).toEqual([[failure]]);
    expect(JSON.stringify(events[0])).not.toContain("worker-secret");
  });

  it("links nested operations by id without copying the parent event", async () => {
    const events: WideLogEvent[] = [];

    await runWideLog(
      {
        kind: "parent",
        fields: { large: "parent-only" },
        sinks: [(event) => void events.push(event)],
      },
      () => runWideLog({ kind: "child" }, async () => undefined),
    );

    const parent = events.find((event) => event.log.kind === "parent")!;
    const child = events.find((event) => event.log.kind === "child")!;
    expect(child.log.parentId).toBe(parent.log.id);
    expect(child).not.toHaveProperty("parent");
    expect(child).not.toHaveProperty("large");
  });

  it("keeps lifecycle fields under logger ownership", async () => {
    const events: WideLogEvent[] = [];

    await runWideLog(
      {
        kind: "real_kind",
        fields: {
          schema: "caller-schema",
          log: { id: "caller-id", kind: "caller-kind" },
          message: "caller-message",
          outcome: "caller-outcome",
        },
        sinks: [(event) => void events.push(event)],
      },
      async () => undefined,
    );

    expect(events[0]).toMatchObject({
      schema: "iterate.wide-log.v1",
      outcome: "ok",
      log: { kind: "real_kind" },
    });
    expect(events[0]!.log.id).not.toBe("caller-id");
  });

  it("bounds messages instead of growing for an entire long-running session", async () => {
    const events: WideLogEvent[] = [];

    await runWideLog(
      { kind: "itx_call", sinks: [(event) => void events.push(event)] },
      async () => {
        for (let index = 0; index < 100; index++) wideLogger.info(`message.${index}`);
      },
    );

    expect(events[0]!.messages).toHaveLength(50);
    expect(events[0]!.dropped).toEqual({ messages: 50 });
  });

  it("caps original and serialized errors together", async () => {
    const events: WideLogEvent[] = [];
    const originalCounts: number[] = [];

    await runWideLog(
      {
        kind: "test",
        sinks: [
          (event, context) => {
            events.push(event);
            originalCounts.push(context.originalErrors.length);
          },
        ],
      },
      async () => {
        for (let index = 0; index < 20; index++) {
          wideLogger.error(
            Object.assign(new Error(`secret ${index}`), { code: `FAILURE_${index}` }),
          );
        }
      },
    );

    expect(originalCounts).toEqual([8]);
    expect(events[0]!.errors).toHaveLength(8);
    expect(events[0]!.dropped).toMatchObject({ errors: 12 });
    expect(JSON.stringify(events[0])).not.toContain("secret");
  });

  it("enforces a final byte budget and redacts non-semantic messages", async () => {
    const events: WideLogEvent[] = [];

    await runWideLog({ kind: "test", sinks: [(event) => void events.push(event)] }, async () => {
      wideLogger.info("prompt with private customer material");
      wideLogger.set({
        arbitrary: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x".repeat(4_000)]),
        ),
      });
    });

    expect(new TextEncoder().encode(JSON.stringify(events[0])).byteLength).toBeLessThanOrEqual(
      MAX_WIDE_LOG_BYTES,
    );
    expect(events[0]!.messages).toEqual([
      expect.objectContaining({ message: "redacted_non_semantic_message" }),
    ]);
    expect(events[0]!.dropped).toMatchObject({ fields: 1 });
    expect(JSON.stringify(events[0])).not.toContain("private customer material");
  });

  it("isolates a failing sink from the product operation", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runWideLog(
        {
          kind: "test",
          sinks: [() => Promise.reject(new Error("sink unavailable"))],
        },
        async () => "product result",
      ),
    ).resolves.toBe("product result");

    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "wide_log_sink_error", operationKind: "test" }),
    );
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
  ])("emits status %s without filtering", async (status, outcome) => {
    const events: WideLogEvent[] = [];

    await runHttpWideLog(
      {
        request: new Request("https://os.iterate.com/test"),
        service: "os",
        deployment: { environment: "preview_1", version: "version-123" },
        sinks: [(event) => void events.push(event)],
      },
      async () => new Response(null, { status }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome, http: { status } });
  });

  it("records safe request fields and the response status without request data", async () => {
    const events: WideLogEvent[] = [];
    const request = new Request("https://os.iterate.com/api?token=query-secret", {
      method: "POST",
      headers: {
        authorization: "Bearer auth-secret",
        cookie: "session=cookie-secret",
        "cf-ray": "ray-123",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      body: "body-secret",
    });

    await runHttpWideLog(
      {
        request,
        service: "os",
        deployment: { environment: "preview_1", version: "version-123" },
        sinks: [(event) => void events.push(event)],
      },
      async () => new Response(null, { status: 204 }),
    );

    expect(events[0]).toMatchObject({
      service: "os",
      deployment: { environment: "preview_1", version: "version-123" },
      http: {
        requestId: "ray-123",
        method: "POST",
        path: "/api",
        status: 204,
      },
      message: "HTTP POST /api 204",
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /query-secret|auth-secret|cookie-secret|body-secret/,
    );
  });

  it("rejects client strings masquerading as correlation ids", async () => {
    const events: WideLogEvent[] = [];
    const request = new Request("https://os.iterate.com/api", {
      headers: {
        "x-request-id": "customer@example.com",
        traceparent: "secret trace value",
      },
    });

    await runHttpWideLog(
      {
        request,
        service: "os",
        deployment: { environment: "preview_1", version: "version-123" },
        sinks: [(event) => void events.push(event)],
      },
      async () => new Response(null, { status: 200 }),
    );

    expect(events[0]!.http).not.toHaveProperty("traceparent");
    expect(Reflect.get(events[0]!.http as object, "requestId")).not.toBe("customer@example.com");
    expect(JSON.stringify(events[0])).not.toMatch(/customer@example.com|secret trace value/);
  });
});
