import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";

const POSTHOG_BATCH_MAX_BYTES = 4_000_000;
const POSTHOG_READ_MAX_EVENTS = 20_000;
const POSTHOG_MAX_ATTEMPTS = 5;
const POSTHOG_RETRY_BASE_MS = [1_000, 5_000, 30_000, 120_000] as const;
const POSTHOG_FLUSH_DELAY_MS = 50;
const POSTHOG_UUID_NAMESPACE = "859c5a5d-bd37-55a7-97d7-443357d30a36";
const STATE_KEY = "posthogStreamEventExport";

let invalidConfigReported = false;

export type CommittedStreamEventTelemetry = Readonly<{
  committedAt: string;
  offset: number;
}>;

type CaptureContext = {
  attempt: number;
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
  | { kind: "timeout" };

type CaptureResult =
  | { outcome: "accepted" }
  | { failure: CaptureFailure; outcome: "failed" | "unknown" };

type TraceSpan = { setAttribute(name: string, value: boolean | number | string): void };

type DurableState = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
};

type ExportState = {
  attempt: number;
  cursor: number;
  generation: number;
  lastError: string | null;
  nextAttemptAt: number | null;
};

type ExporterInput = {
  apiKey: string;
  initialOffset: number;
  projectId: string | null;
  random?: () => number;
  readEvents(afterOffset: number, limit: number): CommittedStreamEventTelemetry[];
  state: DurableState;
  streamId: string;
  workerName: string;
};

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
    if (!invalidConfigReported) {
      invalidConfigReported = true;
      emitError({
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

/**
 * Durable, payload-blind delivery from one stream to PostHog.
 *
 * The existing append log is the outbox. This class stores only an offset,
 * next-attempt time, bounded retry count, recovery generation, and last
 * failure. Product requests never encode JSON or fetch PostHog; they only
 * persist a near-term alarm desire. Each alarm performs at most one request.
 */
export class StreamEventPostHogExporter {
  readonly #apiKey: string;
  readonly #projectId: string | null;
  readonly #random: () => number;
  readonly #readEvents: ExporterInput["readEvents"];
  readonly #state: DurableState;
  readonly #streamId: string;
  readonly #workerName: string;
  #exportState: ExportState;

  constructor(input: ExporterInput) {
    this.#apiKey = input.apiKey;
    this.#projectId = input.projectId;
    this.#random = input.random ?? Math.random;
    this.#readEvents = input.readEvents;
    this.#state = input.state;
    this.#streamId = input.streamId;
    this.#workerName = input.workerName;

    const stored = input.state.get<unknown>(STATE_KEY);
    const parsed = parseExportState(stored);
    this.#exportState = parsed ?? {
      attempt: 0,
      cursor: input.initialOffset,
      generation: 0,
      lastError: null,
      nextAttemptAt: null,
    };
    if (parsed === undefined) this.#persist();
  }

  get nextAttemptAt(): number | null {
    return this.#exportState.nextAttemptAt;
  }

  /** Mark durable work once; the caller publishes this desire to the shared alarm. */
  requestFlush(now = Date.now()): number | null {
    if (this.#exportState.nextAttemptAt !== null) return null;
    const nextAttemptAt = now + POSTHOG_FLUSH_DELAY_MS;
    this.#update({ nextAttemptAt });
    return nextAttemptAt;
  }

  /**
   * Attempt one API-sized page when due. Returns the still-durable next alarm
   * desire, or null when the cursor is caught up.
   */
  async flushIfDue(firedAt = Date.now()): Promise<number | null> {
    if (this.#exportState.nextAttemptAt === null || this.#exportState.nextAttemptAt > firedAt) {
      return this.#exportState.nextAttemptAt;
    }

    const { attempt, cursor, generation } = this.#exportState;
    const candidates = this.#readEvents(cursor, POSTHOG_READ_MAX_EVENTS);
    if (candidates.length === 0) {
      this.#setCaughtUp();
      return null;
    }

    const provisionalContext = this.#captureContext(candidates, attempt + 1);
    const encoded = encodeBatch(this.#apiKey, provisionalContext, candidates);
    const page = candidates.slice(0, encoded.eventCount);
    const context = this.#captureContext(page, attempt + 1);
    const result = await this.#attemptCapture(context, encoded.body);

    // Recovery can replace the log while the fetch is in flight. Its reset
    // owns the new cursor/desire; this stale completion must not acknowledge it.
    if (this.#exportState.generation !== generation || this.#exportState.cursor !== cursor) {
      return this.#exportState.nextAttemptAt;
    }

    if (result.outcome !== "accepted" && isRetryable(result.failure)) {
      if (context.attempt < POSTHOG_MAX_ATTEMPTS) {
        const nextAttemptAt = Date.now() + retryDelay(context.attempt, this.#random());
        this.#update({
          attempt: context.attempt,
          lastError: failureKind(result.failure),
          nextAttemptAt,
        });
        return nextAttemptAt;
      }
      reportAbandoned(context, result.failure);
    } else if (result.outcome !== "accepted") {
      reportAbandoned(context, result.failure);
    }

    // A permanent rejection or exhausted transient retry advances loudly so
    // one bad page cannot hot-loop or block every later event.
    const nextCursor = page.at(-1)!.offset;
    this.#update({
      attempt: 0,
      cursor: nextCursor,
      lastError:
        result.outcome === "accepted"
          ? null
          : `abandoned:${failureKind(result.failure)}:${context.firstOffset}-${context.lastOffset}`,
    });

    if (this.#readEvents(nextCursor, 1).length > 0) {
      const nextAttemptAt = Date.now();
      this.#update({ nextAttemptAt });
      return nextAttemptAt;
    }
    this.#setCaughtUp();
    return null;
  }

  /** Recovery imports are durable history, not new telemetry. */
  resetTo(offset: number): void {
    this.#update({
      attempt: 0,
      cursor: offset,
      generation: this.#exportState.generation + 1,
      lastError: null,
      nextAttemptAt: null,
    });
  }

  async #attemptCapture(context: CaptureContext, body: string | undefined): Promise<CaptureResult> {
    try {
      return await tracing.enterSpan("posthog.capture_stream_events", async (span) => {
        setSpanContext(span, context);
        if (body === undefined) {
          const result = {
            failure: { kind: "oversized", maxBytes: POSTHOG_BATCH_MAX_BYTES },
            outcome: "failed",
          } as const;
          setSpanFailure(span, result.failure, result.outcome);
          span.setAttribute("iterate.telemetry.disposition", "abandoned");
          return result;
        }

        const result = await sendBatch(span, body);
        span.setAttribute(
          "iterate.telemetry.disposition",
          result.outcome === "accepted"
            ? "advanced"
            : isRetryable(result.failure) && context.attempt < POSTHOG_MAX_ATTEMPTS
              ? "retry"
              : "abandoned",
        );
        return result;
      });
    } catch {
      const failure = { kind: "internal" } as const;
      return { failure, outcome: "failed" };
    }
  }

  #captureContext(
    events: readonly CommittedStreamEventTelemetry[],
    attempt: number,
  ): CaptureContext {
    return {
      attempt,
      eventCount: events.length,
      firstOffset: events[0]!.offset,
      lastOffset: events.at(-1)!.offset,
      projectId: this.#projectId,
      streamId: this.#streamId,
      workerName: this.#workerName,
    };
  }

  #setCaughtUp(): void {
    this.#update({ attempt: 0, nextAttemptAt: null });
  }

  #update(patch: Partial<ExportState>): void {
    this.#exportState = { ...this.#exportState, ...patch };
    this.#persist();
  }

  #persist(): void {
    this.#state.put(STATE_KEY, this.#exportState);
  }
}

function validNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseExportState(value: unknown): ExportState | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const state = value as Partial<ExportState>;
  const attempt = validNonNegativeInteger(state.attempt);
  const cursor = validNonNegativeInteger(state.cursor);
  const generation = validNonNegativeInteger(state.generation);
  const nextAttemptAt =
    state.nextAttemptAt === null ? null : validNonNegativeInteger(state.nextAttemptAt);
  if (
    attempt === undefined ||
    cursor === undefined ||
    generation === undefined ||
    (state.lastError !== null && typeof state.lastError !== "string") ||
    nextAttemptAt === undefined
  ) {
    return undefined;
  }
  return { attempt, cursor, generation, lastError: state.lastError, nextAttemptAt };
}

function retryDelay(attempt: number, random: number): number {
  const base = POSTHOG_RETRY_BASE_MS[attempt - 1]!;
  return Math.round(base * (0.8 + Math.min(1, Math.max(0, random)) * 0.4));
}

function encodeBatch(
  apiKey: string,
  context: CaptureContext,
  events: readonly CommittedStreamEventTelemetry[],
): { body: string | undefined; eventCount: number } {
  const prefix = `{"api_key":${JSON.stringify(apiKey)},"batch":[`;
  const suffix = "]}";
  const encoder = new TextEncoder();
  const encodedEvents: string[] = [];
  let byteLength = encoder.encode(prefix + suffix).byteLength;

  for (const event of events) {
    const insertId = `stream:${context.streamId}:${event.offset}`;
    const encoded = JSON.stringify({
      event: "iterate stream event committed",
      uuid: uuidv5(insertId, POSTHOG_UUID_NAMESPACE),
      timestamp: event.committedAt,
      properties: {
        distinct_id: `stream:${context.streamId}`,
        $geoip_disable: true,
        $insert_id: insertId,
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
    const nextByteLength =
      byteLength + (encodedEvents.length === 0 ? 0 : 1) + encoder.encode(encoded).byteLength;
    if (nextByteLength > POSTHOG_BATCH_MAX_BYTES) break;
    byteLength = nextByteLength;
    encodedEvents.push(encoded);
  }

  if (encodedEvents.length === 0) return { body: undefined, eventCount: 1 };
  return { body: prefix + encodedEvents.join(",") + suffix, eventCount: encodedEvents.length };
}

async function sendBatch(span: TraceSpan, body: string): Promise<CaptureResult> {
  let response: Response | undefined;
  try {
    response = await fetch("https://eu.i.posthog.com/batch/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const failure = { kind: "http", status: response.status } as const;
      setSpanFailure(span, failure, "failed");
      return { failure, outcome: "failed" };
    }
    span.setAttribute("iterate.telemetry.outcome", "accepted");
    return { outcome: "accepted" };
  } catch (error) {
    const failure = {
      kind:
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
          ? "timeout"
          : "network",
    } as const;
    setSpanFailure(span, failure, "unknown");
    return { failure, outcome: "unknown" };
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // Response cleanup cannot change a committed stream operation.
    }
  }
}

function setSpanContext(span: TraceSpan, context: CaptureContext): void {
  span.setAttribute("iterate.telemetry.attempt", context.attempt);
  span.setAttribute("iterate.telemetry.event_count", context.eventCount);
  span.setAttribute("iterate.telemetry.first_offset", context.firstOffset);
  span.setAttribute("iterate.telemetry.last_offset", context.lastOffset);
  span.setAttribute("iterate.stream.id", context.streamId);
  span.setAttribute("iterate.stream.scope", context.projectId === null ? "deployment" : "project");
  if (context.projectId !== null) span.setAttribute("iterate.project.id", context.projectId);
}

function setSpanFailure(
  span: TraceSpan,
  failure: CaptureFailure,
  outcome: "failed" | "unknown",
): void {
  span.setAttribute("iterate.telemetry.outcome", outcome);
  span.setAttribute("iterate.telemetry.failure_kind", failureKind(failure));
}

function reportAbandoned(context: CaptureContext, failure: CaptureFailure): void {
  emitError({
    schema: "iterate.stream-telemetry.v1",
    message: "stream_posthog_capture_abandoned",
    operation: "posthog.capture_stream_events",
    outcome: "failed",
    ...context,
    failureKind: failureKind(failure),
  });
}

function failureKind(failure: CaptureFailure): string {
  return failure.kind === "http" ? `http_${failure.status}` : failure.kind;
}

function isRetryable(failure: CaptureFailure): boolean {
  if (["internal", "network", "timeout"].includes(failure.kind)) return true;
  return (
    failure.kind === "http" &&
    (failure.status === 408 || failure.status === 429 || failure.status >= 500)
  );
}

function emitError(value: object): void {
  try {
    console.error(value);
  } catch {
    // Optional telemetry can never change the product operation it observes.
  }
}
