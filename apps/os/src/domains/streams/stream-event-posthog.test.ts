import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSpans,
  recordedSpans,
  resetRecordedSpans,
  tracing,
} from "../../test/cloudflare-workers-shim.ts";
import {
  posthogApiKeyFromStreamEnv,
  resetStreamEventPostHogForRecovery,
  StreamEventPostHogExporter,
  type CommittedStreamEventTelemetry,
} from "./stream-event-posthog.ts";

function events(count = 1, firstOffset = 1): CommittedStreamEventTelemetry[] {
  return Array.from({ length: count }, (_, index) => ({
    committedAt: new Date(Date.UTC(2026, 6, 15, 12, 0, 0, index)).toISOString(),
    offset: firstOffset + index,
  }));
}

function harness(
  rows: CommittedStreamEventTelemetry[] = events(),
  overrides: Partial<ConstructorParameters<typeof StreamEventPostHogExporter>[0]> = {},
  values = new Map<string, unknown>(),
) {
  const state = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => void values.set(key, value),
  };
  const exporter = new StreamEventPostHogExporter({
    apiKey: "phc_public",
    initialOffset: 0,
    projectId: "prj_123",
    random: () => 0.5,
    readEvents: (afterOffset, limit) =>
      rows.filter((event) => event.offset > afterOffset).slice(0, limit),
    state,
    streamId: "d0f00d",
    workerName: "os-prd",
    ...overrides,
  });
  return { exporter, rows, values };
}

function batch(fetch: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetch.mock.calls[call]?.[1]?.body as string) as {
    api_key: string;
    batch: Array<{
      event: string;
      properties: Record<string, unknown>;
      timestamp: string;
      uuid: string;
    }>;
  };
}

function persisted(values: Map<string, unknown>) {
  return values.get("posthogStreamEventExport") as {
    attempt: number;
    cursor: number;
    generation: number;
    lastAbandonment: unknown;
    lastError: string | null;
    nextAttemptAt: number | null;
  };
}

async function flushAll(exporter: StreamEventPostHogExporter, firstAlarmAt: number) {
  let alarmAt: number | null = firstAlarmAt;
  while (alarmAt !== null) alarmAt = await exporter.flushIfDue(alarmAt);
}

beforeEach(() => {
  resetRecordedSpans();
  vi.spyOn(Date, "now").mockReturnValue(10_000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stream event PostHog export", () => {
  it("treats its config as optional for smaller StreamDurableObject hosts", () => {
    expect(posthogApiKeyFromStreamEnv({ STREAM: {} })).toBeUndefined();
    expect(
      posthogApiKeyFromStreamEnv({
        APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: " phc_public " }),
      }),
    ).toBe("phc_public");
  });

  it("disables malformed optional config without exposing it or taking down streams", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { APP_CONFIG_POSTHOG: "sk_live_malformed" };

    expect(posthogApiKeyFromStreamEnv(env)).toBeUndefined();
    expect(posthogApiKeyFromStreamEnv(env)).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith({
      schema: "iterate.stream-telemetry.v1",
      message: "stream_posthog_config_invalid",
      operation: "posthog.configure_stream_events",
      outcome: "disabled",
      failureKind: "config",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("sk_live_malformed");
  });

  it("refuses malformed durable state without overwriting its evidence", () => {
    const malformed = { cursor: "not-an-offset", raw: "preserve me" };
    const values = new Map<string, unknown>([["posthogStreamEventExport", malformed]]);

    expect(() => harness(events(), {}, values)).toThrow(
      "invalid durable PostHog stream export state",
    );
    expect(values.get("posthogStreamEventExport")).toBe(malformed);
  });

  it("refuses to reset malformed durable state during recovery", () => {
    const malformed = { generation: "unknown", raw: "preserve me" };
    const values = new Map<string, unknown>([["posthogStreamEventExport", malformed]]);
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key: string, value: unknown) => void values.set(key, value),
    };

    expect(() => resetStreamEventPostHogForRecovery(state, 10)).toThrow(
      "invalid durable PostHog stream export state",
    );
    expect(values.get("posthogStreamEventExport")).toBe(malformed);
  });

  it("refuses a durable cursor beyond the stream allocator", () => {
    const state = {
      attempt: 0,
      cursor: 2,
      generation: 0,
      lastAbandonment: null,
      lastError: null,
      nextAttemptAt: null,
    };
    const values = new Map<string, unknown>([["posthogStreamEventExport", state]]);

    expect(() => harness(events(), { initialOffset: 1 }, values)).toThrow(
      "PostHog stream export cursor exceeds the stream allocator",
    );
    expect(values.get("posthogStreamEventExport")).toBe(state);
  });

  it("coalesces commits behind an alarm and sends one payload-blind personless batch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const rows = events(201).map((event) => ({
      ...event,
      payload: "must never leave the Worker",
      path: "/agents/private-name",
      type: "private/event",
    })) as CommittedStreamEventTelemetry[];
    const { exporter } = harness(rows);

    expect(exporter.requestFlush(1_000)).toBe(1_050);
    expect(exporter.requestFlush(1_001)).toBe(1_050);
    expect(await exporter.flushIfDue(1_049)).toBe(1_050);
    expect(fetch).not.toHaveBeenCalled();
    await exporter.flushIfDue(1_050);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://eu.i.posthog.com/batch/");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(batch(fetch).api_key).toBe("phc_public");
    expect(batch(fetch).batch).toHaveLength(201);
    expect(batch(fetch).batch[0]).toEqual({
      event: "iterate stream event committed",
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      timestamp: "2026-07-15T12:00:00.000Z",
      properties: {
        distinct_id: "stream:d0f00d",
        $geoip_disable: true,
        $insert_id: "stream:d0f00d:0:1",
        $is_server: true,
        $lib: "iterate-os-worker",
        $process_person_profile: false,
        worker_name: "os-prd",
        stream_scope: "project",
        project_id: "prj_123",
        stream_id: "d0f00d",
        stream_event_offset: 1,
        stream_recovery_generation: 0,
      },
    });
    expect(JSON.stringify(batch(fetch))).not.toMatch(/private|payload|path|type/);
    expect(recordedSpans).toContainEqual({
      name: "posthog.capture_stream_events",
      attributes: {
        "iterate.telemetry.after_offset": 0,
        "iterate.telemetry.attempt": 1,
        "iterate.telemetry.event_count": 201,
        "iterate.telemetry.first_offset": 1,
        "iterate.telemetry.generation": 0,
        "iterate.telemetry.last_offset": 201,
        "iterate.project.id": "prj_123",
        "iterate.stream.id": "d0f00d",
        "iterate.stream.scope": "project",
        "iterate.telemetry.outcome": "accepted",
        "iterate.telemetry.disposition": "advanced",
      },
    });
    expect(activeSpans.size).toBe(0);
  });

  it("captures deployment streams without inventing a project", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(), { projectId: null });

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(batch(fetch).batch[0]?.properties).toMatchObject({ stream_scope: "deployment" });
    expect(batch(fetch).batch[0]?.properties).not.toHaveProperty("project_id");
    expect(recordedSpans[0]?.attributes).not.toHaveProperty("iterate.project.id");
  });

  it("splits a large backlog into one serial API-sized request per alarm without drops", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const rows = events(50_000);
    const { exporter } = harness(rows);

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    const sentOffsets = fetch.mock.calls.flatMap((_, call) =>
      batch(fetch, call).batch.map((event) => event.properties.stream_event_offset),
    );
    expect(sentOffsets).toEqual(rows.map((event) => event.offset));
    for (const [, init] of fetch.mock.calls) {
      expect(new TextEncoder().encode(init?.body as string).byteLength).toBeLessThanOrEqual(
        4_000_000,
      );
    }
  });

  it("retries timeout-unknown batches with byte-identical UUIDs and bodies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));

    const firstAlarm = exporter.requestFlush(1_000)!;
    const retryAt = await exporter.flushIfDue(firstAlarm);
    expect(retryAt).toBe(11_000);
    expect(persisted(values).cursor).toBe(0);
    await exporter.flushIfDue(retryAt!);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "retry",
      "iterate.telemetry.failure_kind": "timeout",
      "iterate.telemetry.outcome": "unknown",
    });
    expect(persisted(values).cursor).toBe(2);
  });

  it("delivers without consuming retry budget when custom tracing fails", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(tracing, "enterSpan").mockImplementationOnce(() => {
      throw new Error("tracing unavailable");
    });
    const { exporter, values } = harness(events(2));

    await flushAll(exporter, exporter.requestFlush(1_000));

    expect(fetch).toHaveBeenCalledOnce();
    expect(persisted(values)).toMatchObject({
      attempt: 0,
      cursor: 2,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it("durably retries a metadata read failure through object eviction", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const values = new Map<string, unknown>();
    const readFailure = vi.fn(() => {
      throw new Error("sqlite temporarily unavailable");
    });
    const first = harness(events(), { readEvents: readFailure }, values).exporter;

    const retryAt = await first.flushIfDue(first.requestFlush(1_000));

    expect(retryAt).toBe(11_000);
    expect(persisted(values)).toMatchObject({ attempt: 1, cursor: 0, nextAttemptAt: 11_000 });
    expect(recordedSpans.at(-1)?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "retry",
      "iterate.telemetry.event_count": 0,
      "iterate.telemetry.failure_kind": "internal",
      "iterate.telemetry.outcome": "failed",
    });

    const reincarnated = harness(events(), {}, values).exporter;
    expect(reincarnated.nextAttemptAt).toBe(11_000);
    await reincarnated.flushIfDue(11_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the previous durable desire when persisting a retry fails", async () => {
    const values = new Map<string, unknown>();
    let failPut = false;
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        if (failPut) throw new Error("kv temporarily unavailable");
        values.set(key, value);
      },
    };
    const first = harness(
      events(),
      {
        readEvents: () => {
          throw new Error("sqlite temporarily unavailable");
        },
        state,
      },
      values,
    ).exporter;
    const dueAt = first.requestFlush(1_000);
    failPut = true;

    await expect(first.flushIfDue(dueAt)).rejects.toThrow("kv temporarily unavailable");
    expect(first.nextAttemptAt).toBe(dueAt);
    expect(persisted(values).nextAttemptAt).toBe(dueAt);

    failPut = false;
    const reincarnated = harness(events(), { state }, values).exporter;
    expect(reincarnated.nextAttemptAt).toBe(dueAt);
  });

  it("abandons a transient batch loudly after five bounded attempts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(persisted(values)).toMatchObject({
      cursor: 2,
      lastAbandonment: {
        afterOffset: 0,
        attempt: 5,
        failureKind: "http_503",
        firstOffset: 1,
        generation: 0,
        lastOffset: 2,
      },
      lastError: null,
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "stream_posthog_capture_abandoned",
        attempt: 5,
        failureKind: "http_503",
      }),
    );
  });

  it("abandons a permanent rejection immediately instead of hot-looping", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(2));

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(fetch).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "stream_posthog_capture_abandoned",
        failureKind: "http_400",
      }),
    );
  });

  it.each([401, 403])(
    "blocks on PostHog auth status %s without advancing or abandoning events",
    async (status) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response(null));
      vi.stubGlobal("fetch", fetch);
      const { exporter, values } = harness(events(2));

      expect(await exporter.flushIfDue(exporter.requestFlush(1_000))).toBeNull();

      expect(fetch).toHaveBeenCalledOnce();
      expect(persisted(values)).toMatchObject({
        attempt: 0,
        cursor: 0,
        lastAbandonment: null,
        lastError: `blocked:http_${status}`,
        nextAttemptAt: null,
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "stream_posthog_capture_blocked",
          failureKind: `http_${status}`,
          firstOffset: 1,
          lastOffset: 2,
        }),
      );
      expect(recordedSpans.at(-1)?.attributes).toMatchObject({
        "iterate.telemetry.disposition": "blocked",
        "iterate.telemetry.failure_kind": `http_${status}`,
      });

      await flushAll(exporter, exporter.requestFlush(2_000));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(persisted(values)).toMatchObject({ cursor: 2, lastError: null });
    },
  );

  it("retains a durable abandonment after a later page succeeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const rows = events(2);
    const { exporter, values } = harness(rows, {
      readEvents: (afterOffset) => rows.filter((event) => event.offset > afterOffset).slice(0, 1),
    });

    await flushAll(exporter, exporter.requestFlush(1_000));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(persisted(values)).toMatchObject({
      cursor: 2,
      lastAbandonment: {
        afterOffset: 0,
        attempt: 1,
        failureKind: "http_400",
        firstOffset: 1,
        generation: 0,
        lastOffset: 1,
        recordedAt: "1970-01-01T00:00:10.000Z",
      },
      lastError: null,
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it("leaves later commits for the next alarm when they arrive during a fetch", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const { exporter, rows } = harness(events(1));

    const firstFlush = exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    rows.push(...events(1, 2));
    expect(exporter.requestFlush(1_100)).toBe(1_050);
    resolveFirst(new Response(null));
    const nextAlarm = await firstFlush;

    expect(nextAlarm).toBe(10_000);
    expect(fetch).toHaveBeenCalledOnce();
    await exporter.flushIfDue(nextAlarm!);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batch(fetch, 1).batch[0]?.properties.stream_event_offset).toBe(2);
  });

  it("generation-fences a recovery that replaces the log during a fetch", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response);
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));

    const flush = exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    exporter.resetTo(100);
    resolveFetch(new Response(null));

    await expect(flush).resolves.toBeNull();
    expect(persisted(values)).toMatchObject({ cursor: 100, generation: 1 });
  });

  it("uses a new dedupe identity when recovery reuses an offset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const { exporter, rows } = harness(events());

    await flushAll(exporter, exporter.requestFlush(1_000));
    const original = batch(fetch).batch[0]!;
    rows.splice(0, rows.length, {
      committedAt: "2026-07-16T12:00:00.000Z",
      offset: 1,
    });
    exporter.resetTo(0);
    await flushAll(exporter, exporter.requestFlush(2_000));
    const recovered = batch(fetch, 1).batch[0]!;

    expect(recovered.uuid).not.toBe(original.uuid);
    expect(recovered.properties.$insert_id).not.toBe(original.properties.$insert_id);
    expect(recovered.properties.stream_recovery_generation).toBe(1);
  });

  it.each([2, 100])(
    "resets a disabled incarnation at recovery instead of retaining cursor %s",
    async (oldCursor) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
      vi.stubGlobal("fetch", fetch);
      const values = new Map<string, unknown>([
        [
          "posthogStreamEventExport",
          {
            attempt: 3,
            cursor: oldCursor,
            generation: 4,
            lastAbandonment: null,
            lastError: "timeout",
            nextAttemptAt: 123,
          },
        ],
      ]);
      const state = {
        get: <T>(key: string) => values.get(key) as T | undefined,
        put: (key: string, value: unknown) => void values.set(key, value),
      };

      resetStreamEventPostHogForRecovery(state, 10);
      const { exporter } = harness(events(1, 11), { initialOffset: 11 }, values);
      await flushAll(exporter, exporter.requestFlush(1_000));

      expect(batch(fetch).batch.map((event) => event.properties.stream_event_offset)).toEqual([11]);
      expect(persisted(values)).toMatchObject({ cursor: 11, generation: 5 });
    },
  );

  it("does not adopt a recovery reset until its surrounding transaction commits", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events());
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key: string, value: unknown) => void values.set(key, value),
    };

    const candidate = resetStreamEventPostHogForRecovery(state, 100);
    // A real Durable Object transaction rolls this write back. Deliberately do
    // not adopt the candidate: the warm exporter must keep serving the old log.
    values.set("posthogStreamEventExport", {
      attempt: 0,
      cursor: 0,
      generation: 0,
      lastAbandonment: null,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(candidate.generation).toBe(1);
    await flushAll(exporter, exporter.requestFlush(1_000));

    expect(batch(fetch).batch[0]?.properties.stream_recovery_generation).toBe(0);
    expect(persisted(values)).toMatchObject({ cursor: 1, generation: 0 });
  });

  it("starts an existing stream at its current offset instead of backfilling history", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const rows = events(11);
    const { exporter } = harness(rows, { initialOffset: 10 });

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(batch(fetch).batch.map((event) => event.properties.stream_event_offset)).toEqual([11]);
  });

  it("restores its durable alarm desire after the object is evicted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const values = new Map<string, unknown>();
    const first = harness(events(), {}, values).exporter;
    expect(first.requestFlush(1_000)).toBe(1_050);

    const reincarnated = harness(events(), {}, values).exporter;
    expect(reincarnated.nextAttemptAt).toBe(1_050);
    expect(await reincarnated.flushIfDue(1_049)).toBe(1_050);
    expect(fetch).not.toHaveBeenCalled();
    await reincarnated.flushIfDue(1_050);

    expect(fetch).toHaveBeenCalledOnce();
    expect(persisted(values).cursor).toBe(1);
  });
});
