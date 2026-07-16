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

type Page = {
  attempt: number;
  blockedBy: string | null;
  createdAt: string;
  pendingOffsets: number[];
  throughOffset: number;
};

type PersistedState = {
  cursor: number;
  dueAt: number | null;
  page: Page | null;
};

type CapturedBatch = {
  created_at: string;
  batch: Array<{
    distinct_id: string;
    event: string;
    options: { process_person_profile: boolean };
    properties: Record<string, unknown>;
    timestamp: string;
    uuid: string;
  }>;
};

type Disposition = "drop" | "ok" | "retry" | "warning";

function events(count = 1, firstOffset = 1): CommittedStreamEventTelemetry[] {
  return Array.from({ length: count }, (_, index) => ({
    committedAt: new Date(Date.UTC(2026, 6, 15, 12, 0, 0, index)).toISOString(),
    eventType: "events.iterate.test/committed",
    offset: firstOffset + index,
  }));
}

function durableState(values: Map<string, unknown>) {
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => void values.set(key, value),
  };
}

function harness(
  rows: CommittedStreamEventTelemetry[] = events(),
  overrides: Partial<ConstructorParameters<typeof StreamEventPostHogExporter>[0]> = {},
  values = new Map<string, unknown>(),
) {
  const exporter = new StreamEventPostHogExporter({
    apiKey: "phc_public",
    initialOffset: 0,
    projectId: "prj_123",
    random: () => 0.5,
    readEvents: (afterOffset, limit) =>
      rows.filter((event) => event.offset > afterOffset).slice(0, limit),
    state: durableState(values),
    streamId: "d0f00d",
    workerName: "os-prd",
    ...overrides,
  });
  return { exporter, rows, values };
}

function persisted(values: Map<string, unknown>): PersistedState {
  return values.get("posthogStreamEventExport") as PersistedState;
}

function captured(fetch: ReturnType<typeof vi.fn>, call = 0): CapturedBatch {
  return JSON.parse(fetch.mock.calls[call]?.[1]?.body as string) as CapturedBatch;
}

function responseFor(
  init: RequestInit | undefined,
  dispositions:
    | Disposition
    | readonly (Disposition | { details?: string; result: Disposition })[] = "ok",
): Response {
  const requested = (JSON.parse(init?.body as string) as CapturedBatch).batch;
  const results = Object.fromEntries(
    requested.map(({ uuid }, index) => {
      const configured = Array.isArray(dispositions) ? dispositions[index] : dispositions;
      return [
        uuid,
        typeof configured === "string" || configured === undefined
          ? { result: configured ?? "ok" }
          : configured,
      ];
    }),
  );
  return Response.json({ results });
}

function acceptingFetch(disposition: "ok" | "warning" = "ok") {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (_input, init) => responseFor(init, disposition));
}

async function flushAll(exporter: StreamEventPostHogExporter, firstAlarmAt: number): Promise<void> {
  let alarmAt: number | null = firstAlarmAt;
  for (let count = 0; alarmAt !== null; count += 1) {
    if (count > 100) throw new Error("exporter did not converge");
    alarmAt = await exporter.flushIfDue(alarmAt);
  }
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
  it("treats config as optional but rejects malformed present config", () => {
    expect(posthogApiKeyFromStreamEnv({ STREAM: {} })).toBeUndefined();
    expect(
      posthogApiKeyFromStreamEnv({
        APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: " phc_public " }),
      }),
    ).toBe("phc_public");
    expect(() => posthogApiKeyFromStreamEnv({ APP_CONFIG_POSTHOG: "secret" })).toThrow(
      "invalid PostHog stream telemetry config",
    );
  });

  it("does no work when PostHog has no durable deadline", async () => {
    const readEvents = vi.fn(() => events());
    const { exporter } = harness(events(), { readEvents });

    await expect(exporter.flushIfDue(10_000)).resolves.toBeNull();

    expect(readEvents).not.toHaveBeenCalled();
  });

  it("blocks malformed or ahead state instead of replaying accepted history", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformed = { cursor: "bad", raw: "customer-secret" };
    const malformedValues = new Map<string, unknown>([["posthogStreamEventExport", malformed]]);
    const malformedExporter = harness(events(), { initialOffset: 1 }, malformedValues).exporter;

    expect(malformedExporter.nextAttemptAt).toBeNull();
    expect(malformedExporter.requestFlush()).toBeNull();
    await expect(malformedExporter.flushIfDue(10_000)).resolves.toBeNull();
    expect(malformedValues.get("posthogStreamEventExport")).toBe(malformed);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        failureKind: "invalid_state",
        message: "stream_posthog_state_blocked",
        outcome: "blocked",
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("customer-secret");

    const aheadValues = new Map<string, unknown>([
      ["posthogStreamEventExport", { cursor: 2, dueAt: null, page: null }],
    ]);
    harness(events(), { initialOffset: 1 }, aheadValues);
    expect(error).toHaveBeenLastCalledWith(expect.objectContaining({ failureKind: "state_ahead" }));
  });

  it("accepts only the current exact state schema", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stored = { cursor: 1, dueAt: null, page: null, legacyAttempt: 0 };
    const values = new Map<string, unknown>([["posthogStreamEventExport", stored]]);

    const { exporter } = harness(events(), { initialOffset: 1 }, values);

    expect(exporter.requestFlush()).toBeNull();
    expect(values.get("posthogStreamEventExport")).toBe(stored);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ failureKind: "invalid_state" }));
  });

  it("lets authoritative recovery repair blocked state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const rows = events(1, 11);
    const values = new Map<string, unknown>([["posthogStreamEventExport", { cursor: "corrupt" }]]);
    const state = durableState(values);
    const { exporter } = harness(rows, { initialOffset: 10, state }, values);

    const reset = resetStreamEventPostHogForRecovery(state, 10);
    exporter.adoptRecoveryState(reset);
    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(captured(fetch).batch.map((event) => event.properties.stream_event_offset)).toEqual([
      11,
    ]);
    expect(persisted(values)).toEqual({ cursor: 11, dueAt: null, page: null });
  });

  it("starts an existing stream at its current offset instead of backfilling", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(11), { initialOffset: 10 });

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(captured(fetch).batch.map((event) => event.properties.stream_event_offset)).toEqual([
      11,
    ]);
  });

  it("coalesces commits into a payload-blind, personless, project-indexed batch", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const rows = events(2).map((event) => ({
      ...event,
      path: "/agents/private-name",
      payload: "must never leave the Worker",
    })) as CommittedStreamEventTelemetry[];
    const { exporter } = harness(rows);

    expect(exporter.requestFlush(1_000)).toBe(1_050);
    expect(exporter.requestFlush(1_001)).toBe(1_050);
    expect(await exporter.flushIfDue(1_049)).toBe(1_050);
    await flushAll(exporter, 1_050);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://eu.i.posthog.com/i/v1/analytics/events");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer phc_public",
        "content-type": "application/json",
        "posthog-attempt": "1",
        "posthog-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        "posthog-request-timestamp": "1970-01-01T00:00:10.000Z",
      },
    });
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(captured(fetch).created_at).toBe("1970-01-01T00:00:01.050Z");
    expect(captured(fetch).batch[0]).toEqual({
      distinct_id: "stream:os-prd:d0f00d",
      event: "iterate stream event committed",
      options: { process_person_profile: false },
      properties: {
        $geoip_disable: true,
        $insert_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        $is_server: true,
        project_id: "prj_123",
        stream_event_offset: 1,
        stream_event_type: "events.iterate.test/committed",
        stream_id: "d0f00d",
        stream_scope: "project",
        worker_name: "os-prd",
      },
      timestamp: "2026-07-15T12:00:00.000Z",
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(captured(fetch).batch[0]?.properties.$insert_id).toBe(captured(fetch).batch[0]?.uuid);
    expect(JSON.stringify(captured(fetch))).not.toMatch(/private-name|payload|path/);
    expect(recordedSpans).toContainEqual({
      name: "posthog.capture_stream_events",
      attributes: {
        "iterate.project.id": "prj_123",
        "iterate.stream.id": "d0f00d",
        "iterate.stream.scope": "project",
        "iterate.telemetry.after_offset": 0,
        "iterate.telemetry.attempt": 1,
        "iterate.telemetry.disposition": "advanced",
        "iterate.telemetry.drop_count": 0,
        "iterate.telemetry.event_count": 2,
        "iterate.telemetry.first_offset": 1,
        "iterate.telemetry.last_offset": 2,
        "iterate.telemetry.outcome": "accepted",
        "iterate.telemetry.pending_count": 0,
        "iterate.telemetry.warning_count": 0,
      },
    });
    expect(activeSpans.size).toBe(0);
  });

  it("omits project identity for deployment-scoped streams", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(), { projectId: null });

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(captured(fetch).batch[0]?.properties).toMatchObject({ stream_scope: "deployment" });
    expect(captured(fetch).batch[0]?.properties).not.toHaveProperty("project_id");
    expect(recordedSpans[0]?.attributes).not.toHaveProperty("iterate.project.id");
  });

  it("persists a fixed page before the outbound request", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response);
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));

    const flush = exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    expect(persisted(values)).toEqual({
      cursor: 0,
      dueAt: 11_000,
      page: {
        attempt: 1,
        blockedBy: null,
        createdAt: "1970-01-01T00:00:01.050Z",
        pendingOffsets: [1, 2],
        throughOffset: 2,
      },
    });

    resolveFetch(responseFor(fetch.mock.calls[0]?.[1]));
    await flush;
  });

  it("retries only pending events from a mixed response after eviction", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_input, init) =>
        responseFor(init, [
          "ok",
          { details: "rate_limited", result: "retry" },
          { details: "invalid_event", result: "drop" },
          "warning",
        ]),
      )
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const rows = events(4);
    const values = new Map<string, unknown>();
    const first = harness(rows, {}, values).exporter;

    const retryAt = await first.flushIfDue(first.requestFlush(1_000)!);

    expect(retryAt).toBe(11_000);
    expect(persisted(values)).toEqual({
      cursor: 0,
      dueAt: 11_000,
      page: {
        attempt: 1,
        blockedBy: null,
        createdAt: "1970-01-01T00:00:01.050Z",
        pendingOffsets: [2],
        throughOffset: 4,
      },
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "invalid_event",
        dropCount: 1,
        message: "stream_posthog_events_dropped",
      }),
    );

    const reincarnated = harness(rows, { initialOffset: 4 }, values).exporter;
    await flushAll(reincarnated, retryAt!);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(captured(fetch, 1).batch.map((event) => event.properties.stream_event_offset)).toEqual([
      2,
    ]);
    expect(captured(fetch, 1).batch[0]?.uuid).toBe(captured(fetch).batch[1]?.uuid);
    expect(captured(fetch, 1).created_at).toBe(captured(fetch).created_at);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "posthog-attempt": "2",
      "posthog-request-id": (fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        "posthog-request-id"
      ],
    });
    expect(persisted(values)).toEqual({ cursor: 4, dueAt: null, page: null });
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "retry",
      "iterate.telemetry.drop_count": 1,
      "iterate.telemetry.pending_count": 1,
      "iterate.telemetry.outcome": "blocked",
    });
  });

  it("advances terminal drops and reports their bounded reason", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_input, init) =>
        responseFor(init, [{ details: "contains private words", result: "drop" }]),
      );
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events());

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(persisted(values)).toEqual({ cursor: 1, dueAt: null, page: null });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "other", outcome: "dropped" }),
    );
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "advanced",
      "iterate.telemetry.outcome": "partial",
    });
  });

  it("retries only a response entry that is missing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_input, init) => {
        const response = (await responseFor(init).json()) as {
          results: Record<string, unknown>;
        };
        delete response.results[Object.keys(response.results)[1]!];
        return Response.json(response);
      })
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(2));

    const retryAt = await exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await flushAll(exporter, retryAt!);

    expect(captured(fetch, 1).batch.map((event) => event.properties.stream_event_offset)).toEqual([
      2,
    ]);
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.failure_kind": "protocol",
      "iterate.telemetry.pending_count": 1,
    });
  });

  it("retries ambiguous transport outcomes with stable identities", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(2));

    const retryAt = await exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await flushAll(exporter, retryAt!);

    expect(captured(fetch, 1).batch.map(({ uuid }) => uuid)).toEqual(
      captured(fetch).batch.map(({ uuid }) => uuid),
    );
    expect(captured(fetch, 1).created_at).toBe(captured(fetch).created_at);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "posthog-request-id": (fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        "posthog-request-id"
      ],
    });
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "retry",
      "iterate.telemetry.failure_kind": "timeout",
    });
  });

  it.each([408, 500, 502, 503, 504])("fast-retries PostHog status %s", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events());

    const retryAt = await exporter.flushIfDue(exporter.requestFlush(1_000)!);

    expect(retryAt).toBe(11_000);
    expect(persisted(values).page?.attempt).toBe(1);
    await flushAll(exporter, retryAt!);
    expect(persisted(values)).toEqual({ cursor: 1, dueAt: null, page: null });
  });

  it("honours a bounded Retry-After floor", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { "retry-after": "20" }, status: 503 }))
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events());

    const retryAt = await exporter.flushIfDue(exporter.requestFlush(1_000)!);

    expect(retryAt).toBe(30_000);
    await flushAll(exporter, retryAt!);
  });

  it("blocks permanent HTTP failures without retrying forever", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));

    const nextAttemptAt = await exporter.flushIfDue(exporter.requestFlush(1_000)!);

    expect(nextAttemptAt).toBeNull();
    expect(persisted(values)).toMatchObject({
      cursor: 0,
      dueAt: null,
      page: { attempt: 1, blockedBy: "http_400", pendingOffsets: [1, 2] },
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        failureKind: "http_400",
        message: "stream_posthog_capture_blocked",
        outcome: "blocked",
      }),
    );
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "blocked",
      "iterate.telemetry.failure_kind": "http_400",
    });

    expect(exporter.requestFlush(20_000)).toBeNull();
    await expect(exporter.flushIfDue(20_000)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("blocks after five bounded transient attempts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events());
    let alarmAt: number | null = exporter.requestFlush(1_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      alarmAt = await exporter.flushIfDue(alarmAt!);
    }

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(alarmAt).toBeNull();
    expect(persisted(values).page?.attempt).toBe(5);
    expect(persisted(values).page?.blockedBy).toBe("http_503");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 5, failureKind: "http_503" }),
    );
    expect(recordedSpans.at(-1)?.attributes).toMatchObject({
      "iterate.telemetry.disposition": "blocked",
    });
  });

  it("surfaces a local metadata read failure without misclassifying it as PostHog", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const values = new Map<string, unknown>();
    const broken = harness(
      events(),
      {
        readEvents: () => {
          throw new Error("sqlite unavailable");
        },
      },
      values,
    ).exporter;

    const dueAt = broken.requestFlush(1_000)!;

    await expect(broken.flushIfDue(dueAt)).rejects.toThrow("sqlite unavailable");
    expect(persisted(values)).toEqual({ cursor: 0, dueAt, page: null });
    const reincarnated = harness(events(), { initialOffset: 1 }, values).exporter;
    expect(reincarnated.nextAttemptAt).toBe(dueAt);
    await flushAll(reincarnated, dueAt);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("blocks when a persisted pending offset disappears", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const values = new Map<string, unknown>([
      [
        "posthogStreamEventExport",
        {
          cursor: 0,
          dueAt: 1_000,
          page: {
            attempt: 1,
            blockedBy: null,
            createdAt: "2026-07-15T12:00:00.000Z",
            pendingOffsets: [2],
            throughOffset: 2,
          },
        },
      ],
    ]);
    const { exporter } = harness(events(1), { initialOffset: 2 }, values);

    await expect(exporter.flushIfDue(1_000)).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: "source_gap", outcome: "blocked" }),
    );
  });

  it("does not send when persisting the in-flight page fails", async () => {
    const values = new Map<string, unknown>();
    let fail = false;
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        if (fail) throw new Error("storage unavailable");
        values.set(key, value);
      },
    };
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const { exporter } = harness(events(), { state }, values);
    const dueAt = exporter.requestFlush(1_000)!;
    fail = true;

    await expect(exporter.flushIfDue(dueAt)).rejects.toThrow("storage unavailable");

    expect(fetch).not.toHaveBeenCalled();
    expect(persisted(values)).toEqual({ cursor: 0, dueAt, page: null });
  });

  it("uses fixed 500-row pages whose worst-case metadata stays bounded", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    const rows = events(1_001).map((event) => ({ ...event, eventType: "x".repeat(256) }));
    const { exporter } = harness(rows);

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map((_, call) => captured(fetch, call).batch.length)).toEqual([
      500, 500, 1,
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(new TextEncoder().encode(init?.body as string).byteLength).toBeLessThan(4_000_000);
    }
  });

  it("leaves commits arriving during a fetch for the next page", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(response)
      .mockImplementation(async (_input, init) => responseFor(init));
    vi.stubGlobal("fetch", fetch);
    const { exporter, rows } = harness(events());

    const firstFlush = exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    rows.push(...events(1, 2));
    // The persisted in-flight deadline, not the already-consumed alarm, owns
    // the page until its response is classified.
    expect(exporter.requestFlush(2_000)).toBe(11_000);
    resolveFetch(responseFor(fetch.mock.calls[0]?.[1]));
    await flushAll(exporter, (await firstFlush)!);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(captured(fetch, 1).batch[0]?.properties.stream_event_offset).toBe(2);
  });

  it("epoch-fences recovery while a request is in flight", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response);
    vi.stubGlobal("fetch", fetch);
    const { exporter, values } = harness(events(2));
    const state = durableState(values);

    const flush = exporter.flushIfDue(exporter.requestFlush(1_000)!);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const reset = resetStreamEventPostHogForRecovery(state, 100);
    exporter.adoptRecoveryState(reset);
    resolveFetch(responseFor(fetch.mock.calls[0]?.[1]));

    await expect(flush).resolves.toBeNull();
    expect(persisted(values)).toEqual({ cursor: 100, dueAt: null, page: null });
  });

  it("delivers once when custom tracing is unavailable", async () => {
    const fetch = acceptingFetch();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(tracing, "enterSpan").mockImplementationOnce(() => {
      throw new Error("tracing unavailable");
    });
    const { exporter, values } = harness(events());

    await flushAll(exporter, exporter.requestFlush(1_000)!);

    expect(fetch).toHaveBeenCalledOnce();
    expect(persisted(values)).toEqual({ cursor: 1, dueAt: null, page: null });
  });
});
