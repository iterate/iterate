import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSpans,
  recordedSpans,
  resetRecordedSpans,
} from "../../test/cloudflare-workers-shim.ts";
import {
  posthogApiKeyFromStreamEnv,
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
    expect(exporter.requestFlush(1_001)).toBeNull();
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
        $insert_id: "stream:d0f00d:1",
        $is_server: true,
        $lib: "iterate-os-worker",
        $process_person_profile: false,
        worker_name: "os-prd",
        stream_scope: "project",
        project_id: "prj_123",
        stream_id: "d0f00d",
        stream_event_offset: 1,
      },
    });
    expect(JSON.stringify(batch(fetch))).not.toMatch(/private|payload|path|type/);
    expect(recordedSpans).toContainEqual({
      name: "posthog.capture_stream_events",
      attributes: {
        "iterate.telemetry.attempt": 1,
        "iterate.telemetry.event_count": 201,
        "iterate.telemetry.first_offset": 1,
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
      lastError: "abandoned:http_503:1-2",
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
    expect(exporter.requestFlush(1_100)).toBeNull();
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
