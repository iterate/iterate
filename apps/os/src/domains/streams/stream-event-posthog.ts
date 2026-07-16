import { tracing } from "cloudflare:workers";

const POSTHOG_BATCH_MAX_BYTES = 4_000_000;
const POSTHOG_MAX_IN_FLIGHT = 4;
const DIAGNOSTIC_REPORT_INTERVAL_MS = 60_000;

let invalidConfigReported = false;
let inFlightCaptures = 0;
const diagnosticLastReportedAt = new Map<string, number>();

type CaptureContext = {
  eventCount: number;
  firstOffset: number;
  lastOffset: number;
  projectId: string | null;
  streamId: string;
  workerName: string;
};

type CaptureFailure =
  | { kind: "http"; status: number }
  | { kind: "internal" }
  | { kind: "network" }
  | { kind: "oversized"; maxBytes: number }
  | { kind: "saturated"; maxInFlight: number }
  | { kind: "timeout" };

type TraceSpan = { setAttribute(name: string, value: boolean | number | string): void };

/**
 * Read the one optional binding owned by stream telemetry. StreamDurableObject
 * is also hosted by streams-example-app, so parsing OS's full AppConfig here
 * would make that smaller host fail during construction.
 */
export function posthogApiKeyFromStreamEnv(env: unknown): string | undefined {
  if (env === null || typeof env !== "object") return undefined;
  const raw = (env as Record<string, unknown>).APP_CONFIG_POSTHOG;
  if (raw === undefined) return undefined;

  try {
    if (typeof raw !== "string") throw new Error("expected a JSON string");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") throw new Error("expected an object");
    const apiKey = (parsed as Record<string, unknown>).apiKey;
    if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("missing apiKey");
    return apiKey.trim();
  } catch {
    // Deployment validation should catch this first. Optional analytics must
    // still never stop the stream store from booting.
    if (!invalidConfigReported) {
      invalidConfigReported = true;
      emitDiagnostic("error", {
        schema: "iterate.stream-telemetry.v1",
        message: "stream_posthog_config_invalid",
        operation: "posthog.configure_stream_events",
        outcome: "disabled",
        failureKind: "config",
      });
    }
    return undefined;
  }
}

type CaptureInput = {
  apiKey: string;
  events: readonly Readonly<{ committedAt: string; offset: number }>[];
  projectId: string | null;
  streamId: string;
  workerName: string;
};

/**
 * Attempt one personless PostHog batch for one committed append. The caller
 * projects raw StreamEvents into this payload-free DTO synchronously, so slow
 * telemetry cannot retain event payloads. There is no sampling, retry, queue,
 * or delivery claim; every modeled failure is observable and cannot reject the
 * append that already committed.
 */
export function captureCommittedStreamEvents(input: CaptureInput): Promise<void> {
  if (input.events.length === 0) return Promise.resolve();

  // Yield so the stream's synchronous post-commit fan-out runs before JSON
  // encoding or network work starts in the shared isolate.
  return Promise.resolve()
    .then(() =>
      tracing.enterSpan("posthog.capture_stream_events", async (span) => {
        const context: CaptureContext = {
          eventCount: input.events.length,
          firstOffset: input.events[0]!.offset,
          lastOffset: input.events.at(-1)!.offset,
          projectId: input.projectId,
          streamId: input.streamId,
          workerName: input.workerName,
        };
        setSpanContext(span, context);

        if (inFlightCaptures >= POSTHOG_MAX_IN_FLIGHT) {
          recordFailure(span, context, {
            kind: "saturated",
            maxInFlight: POSTHOG_MAX_IN_FLIGHT,
          });
          return;
        }

        inFlightCaptures += 1;
        try {
          const body = encodeBatch(input.apiKey, context, input.events);
          if (body === undefined) {
            recordFailure(span, context, {
              kind: "oversized",
              maxBytes: POSTHOG_BATCH_MAX_BYTES,
            });
            return;
          }
          await sendBatch(span, context, body);
        } catch {
          recordFailure(span, context, { kind: "internal" });
        } finally {
          inFlightCaptures -= 1;
        }
      }),
    )
    .catch(() => reportDetachedFailure());
}

function encodeBatch(
  apiKey: string,
  context: CaptureContext,
  events: readonly Readonly<{ committedAt: string; offset: number }>[],
): string | undefined {
  const prefix = `{"api_key":${JSON.stringify(apiKey)},"batch":[`;
  const suffix = "]}";
  const encoder = new TextEncoder();
  const encodedEvents: string[] = [];
  let byteLength = encoder.encode(prefix + suffix).byteLength;

  for (const event of events) {
    const encoded = JSON.stringify({
      event: "iterate stream event committed",
      timestamp: event.committedAt,
      properties: {
        distinct_id: `stream:${context.streamId}`,
        $geoip_disable: true,
        $is_server: true,
        $lib: "iterate-os-worker",
        $process_person_profile: false,
        worker_name: context.workerName,
        stream_scope: context.projectId === null ? "deployment" : "project",
        ...(context.projectId === null ? {} : { project_id: context.projectId }),
        stream_id: context.streamId,
        stream_event_offset: event.offset,
      },
    });
    byteLength += (encodedEvents.length === 0 ? 0 : 1) + encoder.encode(encoded).byteLength;
    if (byteLength > POSTHOG_BATCH_MAX_BYTES) return undefined;
    encodedEvents.push(encoded);
  }

  return prefix + encodedEvents.join(",") + suffix;
}

async function sendBatch(span: TraceSpan, context: CaptureContext, body: string): Promise<void> {
  let response: Response | undefined;
  try {
    response = await fetch("https://eu.i.posthog.com/batch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      recordFailure(span, context, { kind: "http", status: response.status });
      return;
    }
    span.setAttribute("iterate.telemetry.outcome", "accepted");
  } catch (error) {
    recordFailure(span, context, {
      kind:
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
          ? "timeout"
          : "network",
    });
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // Response cleanup cannot change a committed stream operation.
    }
  }
}

function setSpanContext(span: TraceSpan, context: CaptureContext): void {
  span.setAttribute("iterate.telemetry.event_count", context.eventCount);
  span.setAttribute("iterate.telemetry.first_offset", context.firstOffset);
  span.setAttribute("iterate.telemetry.last_offset", context.lastOffset);
  span.setAttribute("iterate.stream.id", context.streamId);
  span.setAttribute("iterate.stream.scope", context.projectId === null ? "deployment" : "project");
  if (context.projectId !== null) span.setAttribute("iterate.project.id", context.projectId);
}

function recordFailure(span: TraceSpan, context: CaptureContext, failure: CaptureFailure): void {
  const failureKind = failure.kind === "http" ? `http_${failure.status}` : failure.kind;
  const outcome = ["network", "timeout"].includes(failure.kind) ? "unknown" : "failed";
  span.setAttribute("iterate.telemetry.outcome", outcome);
  span.setAttribute("iterate.telemetry.failure_kind", failureKind);

  const now = Date.now();
  const lastReportedAt = diagnosticLastReportedAt.get(failureKind);
  if (lastReportedAt !== undefined && now - lastReportedAt < DIAGNOSTIC_REPORT_INTERVAL_MS) return;
  diagnosticLastReportedAt.set(failureKind, now);

  const log = {
    schema: "iterate.stream-telemetry.v1",
    message:
      outcome === "unknown"
        ? "stream_posthog_capture_outcome_unknown"
        : "stream_posthog_capture_failed",
    operation: "posthog.capture_stream_events",
    outcome,
    ...context,
    failureKind,
    ...(failure.kind === "http" ? { httpStatus: failure.status } : {}),
    ...(failure.kind === "oversized" ? { maxBytes: failure.maxBytes } : {}),
    ...(failure.kind === "saturated" ? { maxInFlight: failure.maxInFlight } : {}),
  };
  emitDiagnostic(isTransient(failure) ? "warn" : "error", log);
}

function isTransient(failure: CaptureFailure): boolean {
  if (["network", "saturated", "timeout"].includes(failure.kind)) return true;
  return (
    failure.kind === "http" &&
    (failure.status === 408 || failure.status === 429 || failure.status >= 500)
  );
}

function reportDetachedFailure(): void {
  const failureKind = "detached";
  const now = Date.now();
  const lastReportedAt = diagnosticLastReportedAt.get(failureKind);
  if (lastReportedAt !== undefined && now - lastReportedAt < DIAGNOSTIC_REPORT_INTERVAL_MS) return;
  diagnosticLastReportedAt.set(failureKind, now);
  emitDiagnostic("error", {
    schema: "iterate.stream-telemetry.v1",
    message: "stream_posthog_capture_failed",
    operation: "posthog.capture_stream_events",
    outcome: "failed",
    failureKind,
  });
}

function emitDiagnostic(level: "error" | "warn", value: object): void {
  try {
    console[level](value);
  } catch {
    // Optional telemetry can never change the product operation it observes.
  }
}
