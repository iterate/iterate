import { tracing } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";

const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;
const FLUSH_DELAY_MS = 50;
const UUID_NAMESPACE = "859c5a5d-bd37-55a7-97d7-443357d30a36";
const STATE_KEY = "posthogStreamEventExport";

export type CommittedStreamEventTelemetry = Readonly<{
  committedAt: string;
  eventType: string;
  offset: number;
}>;

type Page = {
  attempt: number;
  blockedBy: string | null;
  createdAt: string;
  pendingOffsets: number[];
  throughOffset: number;
};

type ExportState = {
  cursor: number;
  dueAt: number | null;
  page: Page | null;
};

export type StreamEventPostHogRecoveryState = Readonly<ExportState>;

type DurableState = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
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

type CaptureContext = {
  afterOffset: number;
  attempt: number;
  eventCount: number;
  firstOffset?: number;
  lastOffset?: number;
  projectId: string | null;
  streamId: string;
};

type CaptureResult = {
  dropDetail?: string;
  dropCount: number;
  failureKind?: string;
  pendingOffsets: number[];
  retryDetail?: string;
  retryAfterMs?: number;
  retryable: boolean;
  warningCount: number;
};

type TraceSpan = { setAttribute(name: string, value: boolean | number | string): void };

/** Parse only the optional binding shared by OS and the smaller streams example app. */
export function posthogApiKeyFromStreamEnv(env: unknown): string | undefined {
  if (env === null || typeof env !== "object") return undefined;
  const raw = (env as Record<string, unknown>).APP_CONFIG_POSTHOG;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("invalid PostHog stream telemetry config");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid PostHog stream telemetry config");
  }
  const apiKey =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).apiKey
      : undefined;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("invalid PostHog stream telemetry config");
  }
  return apiKey.trim();
}

/**
 * Exports committed event metadata without touching product payloads.
 *
 * The stream log is the outbox. A bounded persisted page remembers only which
 * offsets PostHog has asked us to retry. Known acknowledgements are never sent
 * again; an ambiguous network outcome remains necessarily at-least-once.
 */
export class StreamEventPostHogExporter {
  readonly #apiKey: string;
  readonly #projectId: string | null;
  readonly #random: () => number;
  readonly #readEvents: ExporterInput["readEvents"];
  readonly #state: DurableState;
  readonly #streamId: string;
  readonly #workerName: string;
  #blocked = false;
  #epoch = 0;
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
    if (stored === undefined) {
      this.#exportState = { cursor: input.initialOffset, dueAt: null, page: null };
      this.#persist();
      return;
    }
    if (
      parsed !== undefined &&
      parsed.cursor <= input.initialOffset &&
      (parsed.page === null || parsed.page.throughOffset <= input.initialOffset)
    ) {
      this.#exportState = parsed;
      if (parsed.page !== null && parsed.page.blockedBy !== null) {
        this.#reportBlocked(parsed.page.blockedBy, this.#captureContext([], parsed.page.attempt));
      }
      if (parsed.cursor < input.initialOffset && parsed.dueAt === null && parsed.page === null) {
        this.#update({ dueAt: Date.now() + FLUSH_DELAY_MS });
      }
      return;
    }

    this.#blocked = true;
    this.#exportState = { cursor: input.initialOffset, dueAt: null, page: null };
    emitError({
      schema: "iterate.stream-telemetry.v1",
      message: "stream_posthog_state_blocked",
      operation: "posthog.configure_stream_events",
      outcome: "blocked",
      failureKind: parsed === undefined ? "invalid_state" : "state_ahead",
      projectId: input.projectId,
      streamId: input.streamId,
    });
  }

  get nextAttemptAt(): number | null {
    return this.#blocked ? null : this.#exportState.dueAt;
  }

  /** Product commits only persist a wake-up desire; they never call PostHog. */
  requestFlush(now = Date.now()): number | null {
    if (this.#blocked) return null;
    if (this.#exportState.page !== null && this.#exportState.page.blockedBy !== null) return null;
    if (this.#exportState.dueAt !== null) return this.#exportState.dueAt;
    const dueAt = now + FLUSH_DELAY_MS;
    this.#update({ dueAt });
    return dueAt;
  }

  /** Attempt at most one bounded page beneath the native alarm trace root. */
  async flushIfDue(firedAt = Date.now()): Promise<number | null> {
    if (this.#blocked || this.#exportState.dueAt === null) return null;
    if (this.#exportState.dueAt !== null && this.#exportState.dueAt > firedAt) {
      return this.#exportState.dueAt;
    }

    const epoch = this.#epoch;
    const cursor = this.#exportState.cursor;
    let page = this.#exportState.page;
    const candidates = this.#readEvents(cursor, PAGE_SIZE);
    let events: CommittedStreamEventTelemetry[];
    if (page === null) {
      if (candidates.length === 0) {
        this.#update({ dueAt: null });
        return null;
      }
      page = {
        attempt: 0,
        blockedBy: null,
        createdAt: new Date(firedAt).toISOString(),
        pendingOffsets: candidates.map(({ offset }) => offset),
        throughOffset: candidates.at(-1)!.offset,
      };
      events = candidates;
    } else {
      const byOffset = new Map(candidates.map((event) => [event.offset, event]));
      events = page.pendingOffsets.flatMap((offset) => {
        const event = byOffset.get(offset);
        return event === undefined ? [] : [event];
      });
      if (events.length !== page.pendingOffsets.length) {
        return this.#block(page, "source_gap", this.#captureContext(events, page.attempt));
      }
    }

    const attempt = page.attempt >= MAX_ATTEMPTS ? MAX_ATTEMPTS : page.attempt + 1;
    page = {
      ...page,
      attempt,
      blockedBy: attempt === MAX_ATTEMPTS ? "attempt_interrupted" : null,
    };
    this.#update({
      dueAt: attempt === MAX_ATTEMPTS ? null : Date.now() + retryDelay(attempt, this.#random()),
      page,
    });
    const context = this.#captureContext(events, attempt);
    const result = await this.#capture(page, events, context);

    // Recovery may replace the log while the outbound fetch yields.
    if (
      this.#epoch !== epoch ||
      this.#exportState.cursor !== cursor ||
      this.#exportState.page?.createdAt !== page.createdAt
    ) {
      return this.#exportState.dueAt;
    }

    if (result.dropCount > 0) this.#reportDrops(context, result);
    if (result.pendingOffsets.length === 0) {
      let dueAt: number | null;
      try {
        dueAt = this.#readEvents(page.throughOffset, 1).length === 0 ? null : Date.now();
      } catch (error) {
        // Never resend a page PostHog has already acknowledged merely because
        // the one-row tail probe failed. Persist progress, then let the native
        // alarm retry surface the local storage failure.
        this.#update({ cursor: page.throughOffset, dueAt: Date.now(), page: null });
        throw error;
      }
      this.#update({ cursor: page.throughOffset, dueAt, page: null });
      return this.#exportState.dueAt;
    }

    const nextPage = { ...page, blockedBy: null, pendingOffsets: result.pendingOffsets };
    return this.#scheduleFailure(
      nextPage,
      result.failureKind ?? "protocol",
      result.retryable,
      result.retryAfterMs,
      context,
      result.retryDetail,
    );
  }

  /** Adopt only after the storage transaction which replaced the log commits. */
  adoptRecoveryState(state: StreamEventPostHogRecoveryState): void {
    this.#epoch += 1;
    this.#blocked = false;
    this.#exportState = { ...state };
  }

  async #capture(
    page: Page,
    events: readonly CommittedStreamEventTelemetry[],
    context: CaptureContext,
  ): Promise<CaptureResult> {
    let completed: CaptureResult | undefined;
    const send = async (span: TraceSpan): Promise<CaptureResult> => {
      setSpanContext(span, context);
      completed = await sendBatch({
        apiKey: this.#apiKey,
        body: encodeBatch(this.#workerName, this.#streamId, this.#projectId, page, events),
        eventOffsets: events.map(({ offset }) => offset),
        eventUuids: events.map((event) => eventUuid(this.#workerName, this.#streamId, event)),
        attempt: context.attempt,
        requestId: pageRequestId(this.#workerName, this.#streamId, this.#exportState.cursor, page),
      });
      setSpanResult(span, completed, context.attempt);
      return completed;
    };

    try {
      return await tracing.enterSpan("posthog.capture_stream_events", (rawSpan) =>
        send(bestEffortSpan(rawSpan)),
      );
    } catch {
      // A failure closing the span must not send the page twice.
      return completed ?? send(NOOP_SPAN);
    }
  }

  #captureContext(
    events: readonly CommittedStreamEventTelemetry[],
    attempt: number,
  ): CaptureContext {
    return {
      afterOffset: this.#exportState.cursor,
      attempt,
      eventCount: events.length,
      ...(events.length === 0
        ? {}
        : { firstOffset: events[0]!.offset, lastOffset: events.at(-1)!.offset }),
      projectId: this.#projectId,
      streamId: this.#streamId,
    };
  }

  #scheduleFailure(
    page: Page,
    failureKind: string,
    retryable: boolean,
    retryAfterMs?: number,
    context = this.#captureContext([], page.attempt),
    detail?: string,
  ): number | null {
    const fastRetry = retryable && page.attempt < MAX_ATTEMPTS;
    if (!fastRetry) return this.#block(page, failureKind, context, detail);
    const dueAt = Date.now() + retryDelay(page.attempt, this.#random(), retryAfterMs);
    this.#update({
      dueAt,
      page: { ...page, blockedBy: null },
    });
    return dueAt;
  }

  #block(page: Page, failureKind: string, context: CaptureContext, detail?: string): null {
    this.#update({ dueAt: null, page: { ...page, blockedBy: failureKind } });
    this.#reportBlocked(failureKind, context, detail);
    return null;
  }

  #reportBlocked(failureKind: string, context: CaptureContext, detail?: string): void {
    emitError({
      schema: "iterate.stream-telemetry.v1",
      message: "stream_posthog_capture_blocked",
      operation: "posthog.capture_stream_events",
      outcome: "blocked",
      failureKind,
      ...(detail === undefined ? {} : { detail }),
      ...context,
    });
  }

  #reportDrops(context: CaptureContext, result: CaptureResult): void {
    emitError({
      schema: "iterate.stream-telemetry.v1",
      message: "stream_posthog_events_dropped",
      operation: "posthog.capture_stream_events",
      outcome: "dropped",
      failureKind: "event_drop",
      dropCount: result.dropCount,
      ...(result.dropDetail === undefined ? {} : { detail: result.dropDetail }),
      ...context,
    });
  }

  #update(patch: Partial<ExportState>): void {
    const next = { ...this.#exportState, ...patch };
    this.#state.put(STATE_KEY, next);
    this.#exportState = next;
  }

  #persist(): void {
    this.#state.put(STATE_KEY, this.#exportState);
  }
}

/** Reset telemetry atomically beside an authoritative recovery log import. */
export function resetStreamEventPostHogForRecovery(
  state: DurableState,
  offset: number,
): StreamEventPostHogRecoveryState {
  const next = { cursor: offset, dueAt: null, page: null } satisfies ExportState;
  state.put(STATE_KEY, next);
  return next;
}

function parseExportState(value: unknown): ExportState | undefined {
  if (!isExactObject(value, ["cursor", "dueAt", "page"])) return undefined;
  const cursor = nonNegativeInteger(value.cursor);
  const dueAt = value.dueAt === null ? null : nonNegativeInteger(value.dueAt);
  const page = value.page === null ? null : parsePage(value.page, cursor);
  if (cursor === undefined || dueAt === undefined || page === undefined) return undefined;
  if (page !== null && (page.blockedBy === null) === (dueAt === null)) return undefined;
  return { cursor, dueAt, page };
}

function parsePage(value: unknown, cursor: number | undefined): Page | null | undefined {
  if (
    cursor === undefined ||
    !isExactObject(value, ["attempt", "blockedBy", "createdAt", "pendingOffsets", "throughOffset"])
  ) {
    return undefined;
  }
  const attempt = nonNegativeInteger(value.attempt);
  const throughOffset = nonNegativeInteger(value.throughOffset);
  if (
    attempt === undefined ||
    attempt > MAX_ATTEMPTS ||
    throughOffset === undefined ||
    throughOffset <= cursor ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.pendingOffsets) ||
    value.pendingOffsets.length === 0 ||
    value.pendingOffsets.length > PAGE_SIZE
  ) {
    return undefined;
  }
  const pendingOffsets = value.pendingOffsets.map(nonNegativeInteger);
  const blockedBy =
    value.blockedBy === null
      ? null
      : typeof value.blockedBy === "string" && /^[a-z0-9_]{1,64}$/.test(value.blockedBy)
        ? value.blockedBy
        : undefined;
  if (
    blockedBy === undefined ||
    pendingOffsets.some((offset) => offset === undefined) ||
    pendingOffsets.some((offset, index) =>
      index === 0 ? offset! <= cursor : offset! <= pendingOffsets[index - 1]!,
    ) ||
    pendingOffsets.at(-1)! > throughOffset ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return undefined;
  }
  return {
    attempt,
    blockedBy,
    createdAt: value.createdAt,
    pendingOffsets: pendingOffsets as number[],
    throughOffset,
  };
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function retryDelay(attempt: number, random: number, retryAfterMs?: number): number {
  const base = RETRY_DELAYS_MS[Math.max(0, attempt - 1)] ?? RETRY_DELAYS_MS.at(-1)!;
  const jittered = Math.round(base * (0.8 + Math.min(1, Math.max(0, random)) * 0.4));
  return retryAfterMs === undefined
    ? jittered
    : Math.max(jittered, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

function encodeBatch(
  workerName: string,
  streamId: string,
  projectId: string | null,
  page: Page,
  events: readonly CommittedStreamEventTelemetry[],
): string {
  return JSON.stringify({
    created_at: page.createdAt,
    batch: events.map((event) => {
      const uuid = eventUuid(workerName, streamId, event);
      return {
        event: "iterate stream event committed",
        uuid,
        distinct_id: `stream:${workerName}:${streamId}`,
        timestamp: event.committedAt,
        options: { process_person_profile: false },
        properties: {
          $geoip_disable: true,
          $insert_id: uuid,
          $is_server: true,
          worker_name: workerName,
          stream_scope: projectId === null ? "deployment" : "project",
          ...(projectId === null ? {} : { project_id: projectId }),
          stream_id: streamId,
          stream_event_type: event.eventType,
          stream_event_offset: event.offset,
        },
      };
    }),
  });
}

function eventUuid(
  workerName: string,
  streamId: string,
  event: CommittedStreamEventTelemetry,
): string {
  return uuidv5(
    JSON.stringify([
      "iterate-stream-event-v1",
      workerName,
      streamId,
      event.offset,
      event.committedAt,
    ]),
    UUID_NAMESPACE,
  );
}

function pageRequestId(workerName: string, streamId: string, cursor: number, page: Page): string {
  return uuidv5(
    JSON.stringify([
      "iterate-stream-page-v1",
      workerName,
      streamId,
      cursor,
      page.throughOffset,
      page.createdAt,
    ]),
    UUID_NAMESPACE,
  );
}

async function sendBatch(args: {
  apiKey: string;
  attempt: number;
  body: string;
  eventOffsets: readonly number[];
  eventUuids: readonly string[];
  requestId: string;
}): Promise<CaptureResult> {
  let response: Response | undefined;
  try {
    response = await fetch("https://eu.i.posthog.com/i/v1/analytics/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        "posthog-attempt": String(args.attempt),
        "posthog-request-id": args.requestId,
        "posthog-request-timestamp": new Date(Date.now()).toISOString(),
        "posthog-sdk-info": "iterate-os-worker/1.0",
        "user-agent": "iterate-os-worker/1.0",
      },
      body: args.body,
      signal: AbortSignal.timeout(5_000),
    });
    const retryAfterMs = parseRetryAfter(response, Date.now());
    if (!response.ok) {
      return failureResult(
        args.eventOffsets,
        `http_${response.status}`,
        [408, 500, 502, 503, 504].includes(response.status),
        retryAfterMs,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failureResult(args.eventOffsets, "protocol", true, retryAfterMs);
    }
    return parseCaptureResponse(body, args.eventUuids, args.eventOffsets, retryAfterMs);
  } catch (error) {
    const kind =
      error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "timeout"
        : "network";
    return failureResult(args.eventOffsets, kind, true);
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // Cleanup cannot change the acknowledgement result.
    }
  }
}

function parseCaptureResponse(
  value: unknown,
  uuids: readonly string[],
  offsets: readonly number[],
  retryAfterMs?: number,
): CaptureResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failureResult(offsets, "protocol", true, retryAfterMs);
  }
  const results = (value as { results?: unknown }).results;
  if (results === null || typeof results !== "object" || Array.isArray(results)) {
    return failureResult(offsets, "protocol", true, retryAfterMs);
  }

  const pendingOffsets: number[] = [];
  let dropCount = 0;
  let warningCount = 0;
  let protocolFailure = false;
  let dropDetail: string | undefined;
  let retryDetail: string | undefined;
  for (let index = 0; index < uuids.length; index += 1) {
    const entry = (results as Record<string, unknown>)[uuids[index]!];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      pendingOffsets.push(offsets[index]!);
      protocolFailure = true;
      continue;
    }
    const result = (entry as { result?: unknown }).result;
    const detail = safeDetail((entry as { details?: unknown }).details);
    if (result === "ok") continue;
    if (result === "warning") {
      warningCount += 1;
      continue;
    }
    if (result === "drop") {
      dropCount += 1;
      dropDetail ??= detail;
      continue;
    }
    pendingOffsets.push(offsets[index]!);
    retryDetail ??= detail;
    if (result !== "retry") protocolFailure = true;
  }

  return {
    pendingOffsets,
    dropCount,
    warningCount,
    retryable: pendingOffsets.length > 0,
    ...(pendingOffsets.length === 0
      ? {}
      : { failureKind: protocolFailure ? "protocol" : "event_retry" }),
    ...(dropDetail === undefined ? {} : { dropDetail }),
    ...(retryDetail === undefined ? {} : { retryDetail }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function failureResult(
  pendingOffsets: readonly number[],
  failureKind: string,
  retryable: boolean,
  retryAfterMs?: number,
): CaptureResult {
  return {
    dropCount: 0,
    failureKind,
    pendingOffsets: [...pendingOffsets],
    retryable,
    warningCount: 0,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function parseRetryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }
  const milliseconds = Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function safeDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "other";
}

function setSpanContext(span: TraceSpan, context: CaptureContext): void {
  span.setAttribute("iterate.telemetry.after_offset", context.afterOffset);
  span.setAttribute("iterate.telemetry.attempt", context.attempt);
  span.setAttribute("iterate.telemetry.event_count", context.eventCount);
  if (context.firstOffset !== undefined) {
    span.setAttribute("iterate.telemetry.first_offset", context.firstOffset);
  }
  if (context.lastOffset !== undefined) {
    span.setAttribute("iterate.telemetry.last_offset", context.lastOffset);
  }
  span.setAttribute("iterate.stream.id", context.streamId);
  span.setAttribute("iterate.stream.scope", context.projectId === null ? "deployment" : "project");
  if (context.projectId !== null) span.setAttribute("iterate.project.id", context.projectId);
}

function setSpanResult(span: TraceSpan, result: CaptureResult, attempt: number): void {
  span.setAttribute("iterate.telemetry.drop_count", result.dropCount);
  span.setAttribute("iterate.telemetry.warning_count", result.warningCount);
  span.setAttribute("iterate.telemetry.pending_count", result.pendingOffsets.length);
  span.setAttribute(
    "iterate.telemetry.outcome",
    result.pendingOffsets.length > 0 ? "blocked" : result.dropCount > 0 ? "partial" : "accepted",
  );
  span.setAttribute(
    "iterate.telemetry.disposition",
    result.pendingOffsets.length === 0
      ? "advanced"
      : result.retryable && attempt < MAX_ATTEMPTS
        ? "retry"
        : "blocked",
  );
  if (result.failureKind !== undefined) {
    span.setAttribute("iterate.telemetry.failure_kind", result.failureKind);
  }
  const detail = result.dropDetail ?? result.retryDetail;
  if (detail !== undefined) span.setAttribute("iterate.telemetry.detail", detail);
}

const NOOP_SPAN: TraceSpan = { setAttribute: () => undefined };

function bestEffortSpan(span: TraceSpan): TraceSpan {
  return {
    setAttribute(name, value) {
      try {
        span.setAttribute(name, value);
      } catch {
        // Span enrichment is optional; delivery is not.
      }
    },
  };
}

function emitError(value: object): void {
  try {
    console.error(value);
  } catch {
    // Diagnostics cannot change product or exporter state.
  }
}
