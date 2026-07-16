import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import {
  captureCommittedStreamEvents,
  posthogApiKeyFromStreamEnv,
} from "./stream-event-posthog.ts";

type CommittedStreamEventTelemetry = Readonly<{ committedAt: string; offset: number }>;

function events(count = 1): CommittedStreamEventTelemetry[] {
  return Array.from({ length: count }, (_, offset) => ({
    committedAt: new Date(Date.UTC(2026, 6, 15, 12, 0, 0, offset)).toISOString(),
    offset,
  }));
}

function input(rows: readonly CommittedStreamEventTelemetry[] = events()) {
  return {
    apiKey: "phc_public",
    events: rows,
    projectId: "prj_123",
    streamId: "d0f00d",
    workerName: "os-prd",
  } as const;
}

function batch(fetch: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetch.mock.calls[call]?.[1]?.body as string) as {
    api_key: string;
    batch: Array<{ event: string; timestamp: string; properties: Record<string, unknown> }>;
  };
}

beforeEach(() => resetRecordedSpans());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stream event PostHog capture", () => {
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

  it("sends one payload-free, personless batch per append after yielding", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const rows = events(201).map((event) => ({
      ...event,
      payload: "must never leave the Worker",
      path: "/agents/private-name",
      type: "private/event",
    }));

    const taintedInput = {
      ...input(rows),
      privateContext: "also must not leave",
    } as Parameters<typeof captureCommittedStreamEvents>[0];
    const capture = captureCommittedStreamEvents(taintedInput);
    expect(fetch).not.toHaveBeenCalled();
    await capture;

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
      timestamp: "2026-07-15T12:00:00.000Z",
      properties: {
        distinct_id: "stream:d0f00d",
        $geoip_disable: true,
        $is_server: true,
        $lib: "iterate-os-worker",
        $process_person_profile: false,
        worker_name: "os-prd",
        stream_scope: "project",
        project_id: "prj_123",
        stream_id: "d0f00d",
        stream_event_offset: 0,
      },
    });
    expect(JSON.stringify(batch(fetch))).not.toMatch(/private|payload|path|type/);
    expect(recordedSpans).toContainEqual({
      name: "posthog.capture_stream_events",
      attributes: {
        "iterate.telemetry.event_count": 201,
        "iterate.telemetry.first_offset": 0,
        "iterate.telemetry.last_offset": 200,
        "iterate.project.id": "prj_123",
        "iterate.stream.id": "d0f00d",
        "iterate.stream.scope": "project",
        "iterate.telemetry.outcome": "accepted",
      },
    });
  });

  it("captures deployment-wide streams without inventing a project", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetch);

    await captureCommittedStreamEvents({ ...input(), projectId: null });

    expect(batch(fetch).batch[0]?.properties).toMatchObject({ stream_scope: "deployment" });
    expect(batch(fetch).batch[0]?.properties).not.toHaveProperty("project_id");
    expect(recordedSpans[0]?.attributes).not.toHaveProperty("iterate.project.id");
  });

  it("rejects an oversized append as one observable unit instead of splitting it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    await captureCommittedStreamEvents(input(events(50_000)));

    expect(fetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        eventCount: 50_000,
        firstOffset: 0,
        lastOffset: 49_999,
        failureKind: "oversized",
        maxBytes: 4_000_000,
      }),
    );
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.outcome": "failed",
      "iterate.telemetry.failure_kind": "oversized",
    });
  });

  it("reports a rejected HTTP range once per failure class per minute", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    await captureCommittedStreamEvents(input(events(2)));
    await captureCommittedStreamEvents(input(events(2)));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "prj_123",
        eventCount: 2,
        firstOffset: 0,
        lastOffset: 1,
        failureKind: "http_400",
        httpStatus: 400,
      }),
    );
    now.mockReturnValue(1_060_000);
    await captureCommittedStreamEvents(input(events(2)));
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("uses warnings for transient PostHog failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    await captureCommittedStreamEvents(input());

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", failureKind: "http_503" }),
    );
  });

  it("bounds concurrent capture work across the isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let resolveFetch: (response: Response) => void = () => undefined;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pendingFetch);
    vi.stubGlobal("fetch", fetch);
    const captures = Array.from({ length: 4 }, () => captureCommittedStreamEvents(input()));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));

    await captureCommittedStreamEvents(input());
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: "saturated", maxInFlight: 4 }),
    );

    resolveFetch(new Response(null));
    await Promise.all(captures);
    await captureCommittedStreamEvents(input());
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("marks network timeouts outcome-unknown without rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetch);

    await expect(captureCommittedStreamEvents(input())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "stream_posthog_capture_outcome_unknown",
        outcome: "unknown",
        failureKind: "timeout",
      }),
    );
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.telemetry.outcome": "unknown",
      "iterate.telemetry.failure_kind": "timeout",
    });
  });
});
