import { DurableObject } from "cloudflare:workers";
import { parseCronExpression } from "cron-schedule";
import { z } from "zod";
import {
  type ChildStreamCreatedEvent,
  type DestroyStreamResult,
  Event,
  EventInput,
  type ProjectSlug,
  type StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor, type BuiltinProcessor } from "@iterate-com/events-contract/sdk";
import { circuitBreakerProcessor } from "./circuit-breaker.ts";
import { jsonataTransformerProcessor } from "./jsonata-transformer.ts";
import type {
  Schedule,
  ScheduleCriteria,
  ScheduleLookupArgs,
  ScheduleRow,
} from "./scheduling-types.ts";
import {
  DUPLICATE_SCHEDULE_THRESHOLD,
  Event as SchedulingEvent,
  HUNG_INTERVAL_TIMEOUT_SECONDS,
  MAX_INTERVAL_SECONDS,
  readScheduleProjectionStateFromTable,
  rowToSchedule,
  ScheduleProjectionState,
  SCHEDULE_ADDED_TYPE,
  ScheduleAddedPayload,
  SCHEDULE_CANCELLED_TYPE,
  ScheduleCancelledPayload,
  SCHEDULE_EXECUTION_FINISHED_TYPE,
  ScheduleExecutionFinishedPayload,
  SCHEDULE_EXECUTION_STARTED_TYPE,
  ScheduleExecutionStartedPayload,
  serializeSchedulePayload,
  deserializeSchedulePayload,
  STREAM_APPEND_SCHEDULED_TYPE,
  StreamAppendScheduledPayload,
} from "./scheduling-types.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";

type ProcessorSlugKey = keyof StreamState["processors"];

function getProcessorState(state: StreamState, slug: string) {
  return state.processors[slug as ProcessorSlugKey];
}

const schedulingProcessor = defineBuiltinProcessor<ScheduleProjectionState>(() => ({
  slug: "scheduler",
  initialState: {},

  reduce({ event, state }) {
    return reduceSchedulingState({
      event,
      schedules: state,
    });
  },

  async afterAppend({ append, event }) {
    if (event.type !== STREAM_APPEND_SCHEDULED_TYPE) {
      return;
    }

    await append({
      type: SCHEDULE_ADDED_TYPE,
      payload: lowerAppendScheduledEvent(event),
      idempotencyKey: getAppendScheduledRewriteIdempotencyKey(event),
    });
  },
}));

const processors: BuiltinProcessor[] = [
  circuitBreakerProcessor,
  jsonataTransformerProcessor,
  schedulingProcessor,
];

/**
 * One stream per Durable Object: an append-only event log persisted in SQLite,
 * with a reduced in-memory projection and newline-delimited fanout for live
 * readers.
 *
 * ## Append lifecycle
 *
 * Every event passes through three phases that intentionally mirror the hooks
 * on `Processor` / `BuiltinProcessor` in `@iterate-com/events-contract/sdk`:
 *
 *   beforeAppend  →  reduce  →  afterAppend
 *
 * The stream core runs its own logic in each phase first (idempotency, offset
 * guards, eventCount, parent propagation), then delegates to the registered
 * builtin processors in the same phase. This is by design: the stream core is
 * effectively the "zeroth" processor, but its state lives at the top level of
 * StreamState (path, eventCount, metadata) rather than under
 * `state.processors`, because it owns structural invariants that are not
 * pluggable.
 *
 * ## Processor asymmetry
 *
 * The design intent is that most stream functionality should be implementable
 * as a Processor: a pluggable unit with `reduce` and `afterAppend` hooks that
 * can, in principle, run across a network boundary (reading the event stream
 * remotely, then deciding whether to enact side effects or append derived
 * events back).
 *
 * BuiltinProcessors are a privileged subset that run in-process inside this
 * Durable Object. Because they share the single-threaded actor, they
 * additionally get a synchronous `beforeAppend` hook that can reject events
 * before they are committed (e.g. the circuit breaker).
 *
 * The stream core itself has a handful of responsibilities that sit outside
 * the processor model entirely: initialization, storage, offset sequencing,
 * parent-tree propagation, and the single Durable Object alarm integration
 * used to multiplex scheduler wakeups.
 *
 * ## Pull subscriptions
 *
 * The `history()` and `stream()` methods expose the event log for pull-based
 * consumption. A remote consumer reads events, then either enacts external
 * side effects or appends derived events to this or other streams. Those
 * consumers are conceptually Processors (not BuiltinProcessors), since they
 * do not run synchronously inside this Durable Object.
 *
 * ## Cloudflare Durable Object docs
 *
 * - https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
 * - https://developers.cloudflare.com/durable-objects/api/state/
 * - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 */
export class StreamDurableObject extends DurableObject<Env> {
  private _state: StreamState | null = null;
  protected readonly _warnedScheduleInOnStart = new Set<string>();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private isInitializing = true;

  private get state(): StreamState {
    if (this._state == null) {
      throw new Error(
        "Stream durable object state was accessed before initialize({ projectSlug, path }) completed. Callers must use getInitializedStreamStub().",
      );
    }

    return this._state;
  }

  /**
   * Hydrates in-memory state from persisted SQLite and ensures the schema
   * exists. This is infrastructure-level bootstrapping, intentionally outside
   * the processor model, because processors depend on a fully initialized
   * stream to operate on.
   *
   * Cloudflare recommends `blockConcurrencyWhile()` in the constructor so
   * requests never observe a half-initialized actor.
   * https://developers.cloudflare.com/durable-objects/api/state/
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();

      const persistedStateRow = this.ctx.storage.sql
        .exec<{ json: string }>("SELECT json FROM reduced_state WHERE singleton = 1")
        .next().value;

      if (persistedStateRow != null) {
        const rawState = JSON.parse(persistedStateRow.json);
        const parsed = StreamState.safeParse(rawState);
        if (parsed.success) {
          this._state = hydratePersistedStreamState({
            ctx: this.ctx,
            rawState,
            state: parsed.data,
          });

          try {
            this.append({
              type: "https://events.iterate.com/events/stream/durable-object-constructed",
              payload: {},
            });
          } catch (error) {
            console.error(
              "[stream-do] failed to append durable-object-constructed after rehydration",
              {
                path: this._state.path,
                error,
              },
            );
            throw error;
          }
        } else {
          // Deliberately not crashing: throwing from the DO constructor makes
          // the object permanently unaddressable and much harder to debug.
          console.error(
            "[stream-do] persisted reduced_state failed validation, leaving _state null so initialize() can re-derive it",
            { error: parsed.error, raw: persistedStateRow.json },
          );
        }
      }

      try {
        await this.onInitialize();
      } finally {
        this.isInitializing = false;
      }
    });
  }

  protected async onInitialize(): Promise<void> {}

  /**
   * Ensures this stream exists. On the very first call, commits a synthetic
   * `stream-initialized` event at offset 1 through `append()`. Subsequent
   * calls are no-ops.
   *
   * Think of this like the durable object constructor. We take arguments like
   * { projectSlug, path } and set the initial state.
   *
   * All external callers go through `getInitializedStreamStub()` in
   * `~/lib/stream-helpers.ts`, which calls this before returning the stub.
   */
  initialize(args: { projectSlug: ProjectSlug; path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    this.ensureSchema();

    const projectSlug = args.projectSlug;
    const processorState = Object.fromEntries(
      processors.map((processor) => [processor.slug, structuredClone(processor.initialState)]),
    ) as StreamState["processors"];

    this._state = {
      projectSlug,
      path: args.path,
      eventCount: 0,
      childPaths: [],
      metadata: {},
      processors: processorState,
    };

    try {
      this.append({
        type: "https://events.iterate.com/events/stream/initialized",
        payload: { projectSlug, path: args.path },
      });
    } catch (error) {
      this._state = null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Append lifecycle
  //
  // The four methods below — append, beforeAppend, reduce, afterAppend —
  // mirror the hook structure on BuiltinProcessor in `@iterate-com/events-contract/sdk`.
  //
  // In each phase the stream core runs its own privileged logic first, then
  // delegates to the registered builtin processors. This symmetry is
  // intentional: the stream core is effectively the "zeroth" processor, but
  // its state lives at the top level of StreamState rather than under
  // `state.processors`, because it owns structural invariants (path,
  // eventCount, initialization, parent propagation) that are not pluggable.
  // ---------------------------------------------------------------------------

  /**
   * Public entry point for appending an event. Handles idempotency up front,
   * then orchestrates the three lifecycle phases and the atomic SQLite commit:
   *
   *   parse → idempotency check → beforeAppend → build event → reduce → commit → afterAppend
   */
  append(inputEvent: EventInput): Event {
    const input = EventInput.parse(inputEvent);

    if (input.idempotencyKey != null) {
      const existingEvent = this.getEventByIdempotencyKey(input.idempotencyKey);
      if (existingEvent != null) {
        return existingEvent;
      }
    }

    const nextOffset = this.beforeAppend(input);

    const event = {
      streamPath: this.state.path,
      ...input,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = this.reduce(event);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (offset, type, payload, metadata, idempotency_key, created_at)
         VALUES (?, ?, json(?), ?, ?, ?)`,
        event.offset,
        event.type,
        JSON.stringify(event.payload),
        event.metadata === undefined ? null : JSON.stringify(event.metadata),
        event.idempotencyKey ?? null,
        event.createdAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO reduced_state (singleton, json)
         VALUES (1, json(?))
         ON CONFLICT(singleton) DO UPDATE SET json = excluded.json`,
        JSON.stringify(nextState),
      );
      applyScheduleProjectionEventSync({
        ctx: this.ctx,
        event,
      });
    });
    this._state = nextState;

    this.afterAppend(event);

    return event;
  }

  /**
   * Validate-or-throw boundary. Enforces core invariants and runs builtin
   * processor gates before any state mutation occurs:
   *
   * 1. Core invariants: stream-initialized uniqueness, offset precondition.
   * 2. Builtin processor beforeAppend hooks (e.g. circuit-breaker rejection).
   *
   * Returns the next offset to use. Idempotency is handled by `append()`
   * before this method is called. By the time we get here, the input is
   * known to be a genuinely new event.
   */
  private beforeAppend(input: EventInput): number {
    if (
      input.type === "https://events.iterate.com/events/stream/initialized" &&
      this.state.eventCount > 0
    ) {
      throw new Error("stream-initialized may only be appended once");
    }

    const nextOffset = this.state.eventCount + 1;

    if (input.offset != null && input.offset !== nextOffset) {
      throw new StreamOffsetPreconditionError(
        `Client-supplied offset ${input.offset} does not match next generated offset ${nextOffset}.`,
      );
    }

    for (const processor of processors) {
      processor.beforeAppend?.({
        event: input,
        state: getProcessorState(this.state, processor.slug),
      });
    }

    return nextOffset;
  }

  /**
   * Pure reduction: computes the next StreamState from the current state and
   * the committed event, without performing any I/O.
   *
   * Core stream state (eventCount, metadata) is reduced first, then each
   * builtin processor reduces its own slice under `state.processors`. This
   * mirrors the processor `reduce` hook but for the privileged top-level
   * fields that are not modeled as processor state.
   */
  private reduce(event: Event): StreamState {
    if (this.state.path !== event.streamPath) {
      throw new Error(
        `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${this.state.path}, but the event has path ${event.streamPath}.`,
      );
    }

    let nextState: StreamState = {
      ...structuredClone(this.state),
      eventCount: this.state.eventCount + 1,
    };

    switch (event.type) {
      case "https://events.iterate.com/events/stream/metadata-updated": {
        const metadataUpdatedEvent = event as StreamMetadataUpdatedEvent;
        nextState = { ...nextState, metadata: metadataUpdatedEvent.payload.metadata };
        break;
      }
      case "https://events.iterate.com/events/stream/child-stream-created": {
        const childPath = getImmediateChildPath({
          parentPath: this.state.path,
          childPath: (event as ChildStreamCreatedEvent).payload.childPath,
        });
        if (childPath != null && !nextState.childPaths.includes(childPath)) {
          nextState = { ...nextState, childPaths: [...nextState.childPaths, childPath] };
        }
        break;
      }
    }

    for (const processor of processors) {
      if (processor.reduce == null) {
        continue;
      }

      const nextSlice = processor.reduce({
        event,
        state: getProcessorState(nextState, processor.slug),
      });
      nextState = {
        ...nextState,
        processors: { ...nextState.processors, [processor.slug]: nextSlice },
      };
    }

    return nextState;
  }

  /**
   * Post-commit side effects, in order:
   *
   * 1. Subscriber fanout: push the committed event to all live pull-subscription
   *    readers connected via `stream()`.
   *
   * 2. Core propagation: after `stream-initialized`, notify every ancestor
   *    stream with `child-stream-created` in parallel. This is a structural
   *    concern of the stream tree, not something a pluggable processor should own.
   *
   * 3. Builtin processor afterAppend hooks: each processor may inspect the
   *    committed event and its own state slice, then optionally append derived
   *    events back into this stream.
   *
   * 4. Scheduler alarm maintenance: schedule control events update the single
   *    Durable Object alarm pointer asynchronously after commit.
   */
  private afterAppend(event: Event) {
    this.publish(event);

    if (event.type === "https://events.iterate.com/events/stream/initialized") {
      const ancestorPaths = getAncestorStreamPaths(event.streamPath);

      void Promise.all(
        ancestorPaths.map(async (path) => {
          const stream = await getInitializedStreamStub({
            projectSlug: this.state.projectSlug,
            path,
          });
          await stream.append({
            type: "https://events.iterate.com/events/stream/child-stream-created",
            payload: { childPath: event.streamPath },
            metadata: event.metadata,
          });
        }),
      ).catch((error) => {
        console.error("[stream-do] failed to propagate event to ancestor streams", {
          path: event.streamPath,
          ancestorPaths,
          eventType: "https://events.iterate.com/events/stream/child-stream-created",
          error,
        });
      });
    }

    for (const processor of processors) {
      const result = processor.afterAppend?.({
        append: (nextEvent: EventInput) => this.append(nextEvent),
        event,
        state: getProcessorState(this.state, processor.slug),
      });

      if (result == null) {
        continue;
      }

      void result.catch((error: unknown) => {
        console.error("[stream-do] processor afterAppend failed", {
          path: this.state.path,
          processor: processor.slug,
          eventType: event.type,
          error,
        });
      });
    }

    if (isScheduleControlEventType(event.type)) {
      void scheduleNextAlarmFromTable(this.ctx).catch((error) => {
        console.error("[stream-do] failed to repoint schedule alarm", {
          path: this.state.path,
          eventType: event.type,
          error,
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduler helpers
  //
  // The methods in this section are closely derived from the Cloudflare Agents
  // SDK scheduler, adapted so our source of truth is stream events plus the
  // scheduler processor state, with `cf_agents_schedules` kept as a SQLite
  // mirror for alarm selection and query efficiency.
  // ---------------------------------------------------------------------------

  async schedule<T = unknown>(
    when: Date | number | string,
    callback: keyof this | string,
    payload?: T,
    options?: { idempotent?: boolean },
  ): Promise<Schedule> {
    await this.ensureInitializedForCurrentName();

    const callbackName = this.validateScheduleCallback(callback);
    const payloadJson = serializeSchedulePayload(payload);

    if (
      this.isInitializing &&
      options?.idempotent == null &&
      typeof when !== "string" &&
      !this._warnedScheduleInOnStart.has(callbackName)
    ) {
      this._warnedScheduleInOnStart.add(callbackName);
      console.warn(
        `schedule("${callbackName}") called inside onInitialize() without { idempotent: true }. ` +
          "This creates a new row on every Durable Object restart, which can cause duplicate executions. " +
          "Pass { idempotent: true } to deduplicate, or use scheduleEvery() for recurring tasks.",
      );
    }

    let addedPayload: z.infer<typeof ScheduleAddedPayload>;
    let existing: ScheduleRow | undefined;

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);

      if (options?.idempotent) {
        existing = getExistingScheduleRow(this.ctx, {
          type: "scheduled",
          callback: callbackName,
          payloadJson,
        });
      }

      addedPayload = {
        scheduleId: existing?.id ?? createScheduleId(),
        callback: callbackName,
        payloadJson,
        scheduleType: "scheduled",
        time: existing?.time ?? timestamp,
      };
    } else if (typeof when === "number") {
      if (!Number.isFinite(when) || when <= 0) {
        throw new Error("Delay schedules require a positive number of seconds.");
      }

      const delaySeconds = Math.floor(when);
      const timestamp = Math.floor(Date.now() / 1000) + delaySeconds;

      if (options?.idempotent) {
        existing = getExistingScheduleRow(this.ctx, {
          type: "delayed",
          callback: callbackName,
          payloadJson,
        });
      }

      addedPayload = {
        scheduleId: existing?.id ?? createScheduleId(),
        callback: callbackName,
        payloadJson,
        scheduleType: "delayed",
        time: existing?.time ?? timestamp,
        delayInSeconds: existing?.delayInSeconds ?? delaySeconds,
      };
    } else if (typeof when === "string") {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);
      const idempotent = options?.idempotent !== false;

      if (idempotent) {
        existing = getExistingScheduleRow(this.ctx, {
          type: "cron",
          callback: callbackName,
          payloadJson,
          cron: when,
        });
      }

      addedPayload = {
        scheduleId: existing?.id ?? createScheduleId(),
        callback: callbackName,
        payloadJson,
        scheduleType: "cron",
        time: existing?.time ?? timestamp,
        cron: existing?.cron ?? when,
      };
    } else {
      throw new Error(
        `Invalid schedule type: ${JSON.stringify(when)} (${typeof when}) trying to schedule ${callbackName}`,
      );
    }

    if (existing == null) {
      this.append({
        type: SCHEDULE_ADDED_TYPE,
        payload: addedPayload,
      });
    }

    await scheduleNextAlarmFromTable(this.ctx);

    const schedule = this.getSchedule(addedPayload.scheduleId);
    if (schedule == null) {
      throw new Error(`Expected schedule ${addedPayload.scheduleId} to exist after scheduling.`);
    }

    return schedule;
  }

  async scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: keyof this | string,
    payload?: T,
    options?: { _idempotent?: boolean },
  ): Promise<Schedule> {
    await this.ensureInitializedForCurrentName();

    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive number");
    }

    if (intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error(`intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`);
    }

    const normalizedIntervalSeconds = Math.floor(intervalSeconds);
    const callbackName = this.validateScheduleCallback(callback);
    const payloadJson = serializeSchedulePayload(payload);
    const idempotent = options?._idempotent !== false;
    const existing = idempotent
      ? getExistingScheduleRow(this.ctx, {
          type: "interval",
          callback: callbackName,
          payloadJson,
          intervalSeconds: normalizedIntervalSeconds,
        })
      : undefined;

    if (existing == null) {
      this.append({
        type: SCHEDULE_ADDED_TYPE,
        payload: {
          scheduleId: createScheduleId(),
          callback: callbackName,
          payloadJson,
          scheduleType: "interval",
          time: Math.floor(Date.now() / 1000) + normalizedIntervalSeconds,
          intervalSeconds: normalizedIntervalSeconds,
        },
      });
    }

    await scheduleNextAlarmFromTable(this.ctx);

    const scheduleId =
      existing?.id ??
      getLatestScheduleIdFor(this.ctx, {
        type: "interval",
        callback: callbackName,
        payloadJson,
        intervalSeconds: normalizedIntervalSeconds,
      });

    if (scheduleId == null) {
      throw new Error("Failed to resolve interval schedule after scheduling.");
    }

    const schedule = this.getSchedule(scheduleId);
    if (schedule == null) {
      throw new Error(`Expected schedule ${scheduleId} to exist after scheduling.`);
    }

    return schedule;
  }

  getSchedule(id: string): Schedule | undefined {
    const row = this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
                running, execution_started_at, retry_options, created_at
         FROM cf_agents_schedules
         WHERE id = ?
         LIMIT 1`,
        id,
      )
      .next().value;

    return row == null ? undefined : rowToSchedule(row);
  }

  getSchedules(criteria: ScheduleCriteria = {}): Schedule[] {
    let query = `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
                        running, execution_started_at, retry_options, created_at
                 FROM cf_agents_schedules
                 WHERE 1 = 1`;
    const params: Array<string | number> = [];

    if (criteria.id != null) {
      query += " AND id = ?";
      params.push(criteria.id);
    }

    if (criteria.type != null) {
      query += " AND type = ?";
      params.push(criteria.type);
    }

    if (criteria.timeRange != null) {
      query += " AND time >= ? AND time <= ?";
      params.push(
        Math.floor((criteria.timeRange.start ?? new Date(0)).getTime() / 1000),
        Math.floor((criteria.timeRange.end ?? new Date(999999999999999)).getTime() / 1000),
      );
    }

    return this.ctx.storage.sql
      .exec<ScheduleRow>(query, ...params)
      .toArray()
      .map(rowToSchedule);
  }

  async cancelSchedule(id: string): Promise<boolean> {
    await this.ensureInitializedForCurrentName();

    if (this.getSchedule(id) == null) {
      return false;
    }

    this.append({
      type: SCHEDULE_CANCELLED_TYPE,
      payload: {
        scheduleId: id,
      },
    });

    await scheduleNextAlarmFromTable(this.ctx);
    return true;
  }

  async alarm() {
    await this.ensureInitializedForCurrentName();

    await runScheduleAlarm({
      append: (event) => this.append(event),
      ctx: this.ctx,
      instance: this,
    });
  }

  protected wasScheduleWarningEmitted(callback: string) {
    return this._warnedScheduleInOnStart.has(callback);
  }

  protected async ensureInitializedForCurrentName() {
    if (this._state != null) {
      return;
    }

    const rawName = Reflect.get(this.ctx.id as object, "name");
    if (typeof rawName !== "string") {
      throw new Error("Unable to derive stream durable object name");
    }

    const separatorIndex = rawName.indexOf("::");
    if (separatorIndex < 0) {
      throw new Error(`Malformed stream durable object name "${rawName}"`);
    }

    const projectSlug = rawName.slice(0, separatorIndex) as ProjectSlug;
    const path = StreamPath.parse(rawName.slice(separatorIndex + 2));
    this.initialize({ projectSlug, path });
  }

  private validateScheduleCallback(callback: PropertyKey) {
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof Reflect.get(this, callback) !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    return callback;
  }

  private getProjectSlugFromCurrentName(): ProjectSlug | null {
    const rawName = Reflect.get(this.ctx.id as object, "name");
    if (typeof rawName !== "string") {
      return null;
    }

    const separatorIndex = rawName.indexOf("::");
    if (separatorIndex < 0) {
      return null;
    }

    return rawName.slice(0, separatorIndex) as ProjectSlug;
  }

  // ---------------------------------------------------------------------------
  // State & lifecycle
  // ---------------------------------------------------------------------------

  getState(): StreamState {
    return this.state;
  }

  async destroy(args: { destroyChildren?: boolean } = {}): Promise<DestroyStreamResult> {
    const childEntries: DestroyStreamResult["finalStateByPath"] = args.destroyChildren
      ? await Promise.all(
          [...this.state.childPaths].sort().map(async (path) => {
            const stub = await getInitializedStreamStub({
              projectSlug: this.state.projectSlug,
              path,
            });
            return stub.destroy({ destroyChildren: true });
          }),
        ).then((results) =>
          results.reduce<DestroyStreamResult["finalStateByPath"]>(
            (acc, { finalStateByPath }) => ({ ...acc, ...finalStateByPath }),
            {},
          ),
        )
      : {};
    const stateBeforeDelete = structuredClone(this._state);
    const path = stateBeforeDelete?.path;

    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }
    this.subscribers.clear();

    await this.ctx.storage.deleteAll();

    this._state = null;

    const finalStateByPath: DestroyStreamResult["finalStateByPath"] = {
      ...childEntries,
      ...(path == null ? {} : { [path]: { finalState: stateBeforeDelete } }),
    };

    return {
      destroyedStreamCount: Object.keys(finalStateByPath).length,
      finalStateByPath,
    };
  }

  // ---------------------------------------------------------------------------
  // Pull subscriptions
  // ---------------------------------------------------------------------------

  history(args: { afterOffset?: number } = {}): Event[] {
    const afterOffset = args.afterOffset ?? 0;

    return this.ctx.storage.sql
      .exec<SqliteEventRow>(
        `SELECT * FROM events WHERE offset > ? ORDER BY offset ASC`,
        afterOffset,
      )
      .toArray()
      .flatMap((row) => {
        const event = this.parseEventRow(row);
        return event ? [event] : [];
      });
  }

  stream(args: { afterOffset?: number; live?: boolean } = {}): ReadableStream<Uint8Array> {
    const backlog = this.history(args);
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of backlog) {
          controller.enqueue(encodeEventLine(event));
        }

        if (!args.live) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber) {
          this.subscribers.delete(subscriber);
        }
      },
    });
  }

  private publish(event: Event) {
    const chunk = encodeEventLine(event);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(chunk);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Storage & helpers
  // ---------------------------------------------------------------------------

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        offset INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reduced_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        json TEXT NOT NULL CHECK(json_valid(json))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY,
        callback TEXT NOT NULL,
        payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        execution_started_at INTEGER,
        retry_options TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  private getEventByIdempotencyKey(idempotencyKey: string) {
    const row = this.ctx.storage.sql
      .exec<SqliteEventRow>(
        `SELECT * FROM events WHERE idempotency_key = ? LIMIT 1`,
        idempotencyKey,
      )
      .next().value;

    return row ? this.parseEventRow(row) : null;
  }

  private parseEventRow(row: SqliteEventRow) {
    if (row == null) {
      return null;
    }

    return Event.parse({
      streamPath: this.state.path,
      offset: row.offset,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
    });
  }
}

const textEncoder = new TextEncoder();

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

type SqliteEventRow = {
  offset: number;
  type: string;
  payload: string;
  metadata: string | null;
  idempotency_key: string | null;
  created_at: string;
};

function getImmediateChildPath(args: {
  parentPath: StreamPath;
  childPath: StreamPath;
}): StreamPath | null {
  if (args.childPath === args.parentPath) {
    return null;
  }

  if (args.parentPath === "/") {
    const [firstSegment] = args.childPath.split("/").filter(Boolean);
    return firstSegment == null ? null : StreamPath.parse(`/${firstSegment}`);
  }

  const parentPrefix = `${args.parentPath}/`;
  if (!args.childPath.startsWith(parentPrefix)) {
    return null;
  }

  const remainingPath = args.childPath.slice(parentPrefix.length);
  const [firstSegment] = remainingPath.split("/");
  return firstSegment == null ? null : StreamPath.parse(`${args.parentPath}/${firstSegment}`);
}

function hydratePersistedStreamState(args: {
  ctx: DurableObjectState;
  rawState: unknown;
  state: StreamState;
}): StreamState {
  if (Object.keys(args.state.processors.scheduler).length > 0) {
    return args.state;
  }

  const schedulerState = getSchedulerStateFromRawState(args.rawState);
  if (schedulerState != null) {
    return {
      ...args.state,
      processors: {
        ...args.state.processors,
        scheduler: schedulerState,
      },
    };
  }

  const tableSchedulerState = readScheduleProjectionStateFromTable(args.ctx);
  if (Object.keys(tableSchedulerState).length === 0) {
    return args.state;
  }

  return {
    ...args.state,
    processors: {
      ...args.state.processors,
      scheduler: tableSchedulerState,
    },
  };
}

function getSchedulerStateFromRawState(rawState: unknown): ScheduleProjectionState | null {
  if (typeof rawState !== "object" || rawState == null || !("cf_agents_schedules" in rawState)) {
    return null;
  }

  return readLegacySchedulerState(rawState.cf_agents_schedules);
}

function readLegacySchedulerState(value: unknown): ScheduleProjectionState | null {
  try {
    return ScheduleProjectionState.parse(value);
  } catch {
    return null;
  }
}

function getAppendScheduledRewriteIdempotencyKey(event: Event) {
  return `scheduler:rewrite:${event.streamPath}:${event.offset}`;
}

function lowerAppendScheduledEvent(event: Event): z.infer<typeof ScheduleAddedPayload> {
  const payload = StreamAppendScheduledPayload.parse(event.payload);
  const createdAt = new Date(event.createdAt);
  const createdAtSeconds = Math.floor(createdAt.getTime() / 1000);
  const payloadJson = serializeSchedulePayload(payload.append);

  switch (payload.schedule.kind) {
    case "once-at":
      return {
        scheduleId: payload.scheduleId,
        callback: "append",
        payloadJson,
        scheduleType: "scheduled",
        time: Math.floor(new Date(payload.schedule.at).getTime() / 1000),
      };
    case "once-in":
      return {
        scheduleId: payload.scheduleId,
        callback: "append",
        payloadJson,
        scheduleType: "delayed",
        time: createdAtSeconds + payload.schedule.delaySeconds,
        delayInSeconds: payload.schedule.delaySeconds,
      };
    case "every":
      if (payload.schedule.intervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Error(`intervalSeconds cannot exceed ${MAX_INTERVAL_SECONDS} seconds (30 days)`);
      }

      return {
        scheduleId: payload.scheduleId,
        callback: "append",
        payloadJson,
        scheduleType: "interval",
        time: createdAtSeconds + payload.schedule.intervalSeconds,
        intervalSeconds: payload.schedule.intervalSeconds,
      };
    case "cron":
      return {
        scheduleId: payload.scheduleId,
        callback: "append",
        payloadJson,
        scheduleType: "cron",
        time: Math.floor(getNextCronTime(payload.schedule.cron, createdAt).getTime() / 1000),
        cron: payload.schedule.cron,
      };
    default:
      throw new Error(`Unsupported append schedule kind ${JSON.stringify(payload.schedule)}`);
  }
}

function isScheduleControlEventType(type: string): boolean {
  switch (type) {
    case SCHEDULE_ADDED_TYPE:
    case SCHEDULE_CANCELLED_TYPE:
    case SCHEDULE_EXECUTION_STARTED_TYPE:
    case SCHEDULE_EXECUTION_FINISHED_TYPE:
      return true;
    default:
      return false;
  }
}

function reduceSchedulingState(args: {
  event: SchedulingEvent;
  schedules: ScheduleProjectionState;
}): ScheduleProjectionState {
  switch (args.event.type) {
    case SCHEDULE_ADDED_TYPE: {
      const payload = ScheduleAddedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      nextSchedules[payload.scheduleId] = {
        id: payload.scheduleId,
        callback: payload.callback,
        payload: payload.payloadJson ?? null,
        type: payload.scheduleType,
        time: payload.time,
        delayInSeconds: payload.delayInSeconds ?? null,
        cron: payload.cron ?? null,
        intervalSeconds: payload.intervalSeconds ?? null,
        running: 0,
        execution_started_at: null,
        retry_options: null,
        created_at: Math.floor(new Date(args.event.createdAt).getTime() / 1000),
      };
      return nextSchedules;
    }
    case SCHEDULE_CANCELLED_TYPE: {
      const payload = ScheduleCancelledPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      delete nextSchedules[payload.scheduleId];
      return nextSchedules;
    }
    case SCHEDULE_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleExecutionStartedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return args.schedules;
      }

      nextSchedules[payload.scheduleId] = {
        ...schedule,
        running: 1,
        execution_started_at: payload.startedAt,
      };
      return nextSchedules;
    }
    case SCHEDULE_EXECUTION_FINISHED_TYPE: {
      const payload = ScheduleExecutionFinishedPayload.parse(args.event.payload);
      const nextSchedules = { ...args.schedules };
      const schedule = nextSchedules[payload.scheduleId];
      if (schedule == null) {
        return args.schedules;
      }

      if (payload.nextTime == null) {
        delete nextSchedules[payload.scheduleId];
        return nextSchedules;
      }

      nextSchedules[payload.scheduleId] = {
        ...schedule,
        time: payload.nextTime,
        running: 0,
        execution_started_at: null,
      };
      return nextSchedules;
    }
    default:
      return args.schedules;
  }
}

function applyScheduleProjectionEventSync(args: { ctx: DurableObjectState; event: Event }): void {
  switch (args.event.type) {
    case SCHEDULE_ADDED_TYPE: {
      const payload = ScheduleAddedPayload.parse(args.event.payload);
      args.ctx.storage.sql.exec(
        `INSERT INTO cf_agents_schedules (
           id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
           running, execution_started_at, retry_options, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           callback = excluded.callback,
           payload = excluded.payload,
           type = excluded.type,
           time = excluded.time,
           delayInSeconds = excluded.delayInSeconds,
           cron = excluded.cron,
           intervalSeconds = excluded.intervalSeconds,
           running = 0,
           execution_started_at = NULL`,
        payload.scheduleId,
        payload.callback,
        payload.payloadJson ?? null,
        payload.scheduleType,
        payload.time,
        payload.delayInSeconds ?? null,
        payload.cron ?? null,
        payload.intervalSeconds ?? null,
        Math.floor(new Date(args.event.createdAt).getTime() / 1000),
      );
      return;
    }
    case SCHEDULE_CANCELLED_TYPE: {
      const payload = ScheduleCancelledPayload.parse(args.event.payload);
      args.ctx.storage.sql.exec(`DELETE FROM cf_agents_schedules WHERE id = ?`, payload.scheduleId);
      return;
    }
    case SCHEDULE_EXECUTION_STARTED_TYPE: {
      const payload = ScheduleExecutionStartedPayload.parse(args.event.payload);
      args.ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET running = 1, execution_started_at = ?
         WHERE id = ?`,
        payload.startedAt,
        payload.scheduleId,
      );
      return;
    }
    case SCHEDULE_EXECUTION_FINISHED_TYPE: {
      const payload = ScheduleExecutionFinishedPayload.parse(args.event.payload);
      if (payload.nextTime == null) {
        args.ctx.storage.sql.exec(
          `DELETE FROM cf_agents_schedules WHERE id = ?`,
          payload.scheduleId,
        );
        return;
      }

      args.ctx.storage.sql.exec(
        `UPDATE cf_agents_schedules
         SET time = ?, running = 0, execution_started_at = NULL
         WHERE id = ?`,
        payload.nextTime,
        payload.scheduleId,
      );
      return;
    }
    default:
      return;
  }
}

async function scheduleNextAlarmFromTable(ctx: DurableObjectState): Promise<void> {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const hungCutoffSeconds = nowSeconds - HUNG_INTERVAL_TIMEOUT_SECONDS;

  const readySchedule = ctx.storage.sql
    .exec<{ time: number }>(
      `SELECT time
       FROM cf_agents_schedules
       WHERE type != 'interval'
          OR running = 0
          OR coalesce(execution_started_at, 0) <= ?
       ORDER BY time ASC
       LIMIT 1`,
      hungCutoffSeconds,
    )
    .next().value;

  const recoveringInterval = ctx.storage.sql
    .exec<{ execution_started_at: number | null }>(
      `SELECT execution_started_at
       FROM cf_agents_schedules
       WHERE type = 'interval'
         AND running = 1
         AND coalesce(execution_started_at, 0) > ?
       ORDER BY execution_started_at ASC
       LIMIT 1`,
      hungCutoffSeconds,
    )
    .next().value;

  let nextTimeMs: number | null = null;
  if (readySchedule?.time != null) {
    nextTimeMs = Math.max(readySchedule.time * 1000, nowMs + 1);
  }

  if (recoveringInterval?.execution_started_at != null) {
    const recoveryTimeMs =
      (recoveringInterval.execution_started_at + HUNG_INTERVAL_TIMEOUT_SECONDS) * 1000;
    nextTimeMs = nextTimeMs == null ? recoveryTimeMs : Math.min(nextTimeMs, recoveryTimeMs);
  }

  if (nextTimeMs == null) {
    await ctx.storage.deleteAlarm();
    return;
  }

  await ctx.storage.setAlarm(nextTimeMs);
}

async function runScheduleAlarm(args: {
  append(event: EventInput): Promise<unknown> | unknown;
  ctx: DurableObjectState;
  instance: object;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dueSchedules = args.ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules
       WHERE time <= ?
       ORDER BY time ASC, created_at ASC`,
      now,
    )
    .toArray();

  if (dueSchedules.length > 0) {
    const oneShotCounts = new Map<string, number>();
    for (const row of dueSchedules) {
      if (row.type === "delayed" || row.type === "scheduled") {
        oneShotCounts.set(row.callback, (oneShotCounts.get(row.callback) ?? 0) + 1);
      }
    }

    for (const [callback, count] of oneShotCounts) {
      if (count < DUPLICATE_SCHEDULE_THRESHOLD) {
        continue;
      }

      console.warn(
        `Processing ${count} stale "${callback}" schedules in a single alarm cycle. ` +
          "This usually means schedule() is being called repeatedly without the idempotent option. " +
          "Consider using scheduleEvery() for recurring tasks or passing { idempotent: true } to schedule().",
      );
    }
  }

  for (const row of dueSchedules) {
    const callback = Reflect.get(args.instance, row.callback);
    if (typeof callback !== "function") {
      console.error("[stream-do] schedule callback not found", {
        callback: row.callback,
        scheduleId: row.id,
      });

      try {
        await appendScheduleExecutionFinished({
          append: args.append,
          nextTime: null,
          outcome: "failed",
          scheduleId: row.id,
        });
      } catch (appendError) {
        console.error(`[stream-do] failed to retire missing callback schedule "${row.callback}"`, {
          appendError,
          scheduleId: row.id,
        });
      }

      continue;
    }

    if (row.type === "interval" && row.running === 1) {
      const executionStartedAt = row.execution_started_at ?? 0;
      const elapsedSeconds = now - executionStartedAt;

      if (elapsedSeconds < HUNG_INTERVAL_TIMEOUT_SECONDS) {
        console.warn(`Skipping interval schedule ${row.id}: previous execution still running`);
        continue;
      }

      console.warn(
        `Forcing reset of hung interval schedule ${row.id} (started ${elapsedSeconds}s ago)`,
      );
    }

    try {
      if (row.type === "interval") {
        await args.append({
          type: SCHEDULE_EXECUTION_STARTED_TYPE,
          payload: {
            scheduleId: row.id,
            startedAt: now,
          },
        });
      }

      await callback.call(
        args.instance,
        deserializeSchedulePayload(row.payload),
        rowToSchedule(row),
      );

      await appendScheduleExecutionFinished({
        append: args.append,
        nextTime: getNextExecutionTime(row),
        outcome: "succeeded",
        scheduleId: row.id,
      });
    } catch (error) {
      console.error(`[stream-do] error executing callback "${row.callback}"`, error);

      try {
        await appendScheduleExecutionFinished({
          append: args.append,
          nextTime: getSafeFailedNextTime({ now, row }),
          outcome: "failed",
          scheduleId: row.id,
        });
      } catch (appendError) {
        console.error(`[stream-do] failed to record schedule failure "${row.callback}"`, {
          appendError,
          scheduleId: row.id,
        });
      }
    }
  }

  await scheduleNextAlarmFromTable(args.ctx);
}

async function appendScheduleExecutionFinished(args: {
  append(event: EventInput): Promise<unknown> | unknown;
  nextTime: number | null;
  outcome: "failed" | "succeeded";
  scheduleId: string;
}) {
  await args.append({
    type: SCHEDULE_EXECUTION_FINISHED_TYPE,
    payload: {
      scheduleId: args.scheduleId,
      outcome: args.outcome,
      nextTime: args.nextTime,
    },
  });
}

function getSafeFailedNextTime(args: { now: number; row: ScheduleRow }) {
  if (args.row.type === "interval") {
    const intervalSeconds = args.row.intervalSeconds;
    return intervalSeconds == null ? null : args.now + intervalSeconds;
  }

  if (args.row.type === "cron") {
    try {
      return getNextExecutionTime(args.row);
    } catch {
      return null;
    }
  }

  return null;
}

function getNextExecutionTime(row: ScheduleRow) {
  switch (row.type) {
    case "cron":
      return Math.floor(getNextCronTime(row.cron ?? "").getTime() / 1000);
    case "interval": {
      const intervalSeconds = row.intervalSeconds;
      return intervalSeconds == null ? null : Math.floor(Date.now() / 1000) + intervalSeconds;
    }
    default:
      return null;
  }
}

function getNextCronTime(cron: string, startDate?: Date) {
  return parseCronExpression(cron).getNextDate(startDate);
}

function getExistingScheduleRow(ctx: DurableObjectState, args: ScheduleLookupArgs) {
  const clauses = ["type = ?", "callback = ?", "payload IS ?"];
  const params: Array<string | number | null> = [args.type, args.callback, args.payloadJson];

  if (args.cron != null) {
    clauses.push("cron = ?");
    params.push(args.cron);
  }

  if (args.intervalSeconds != null) {
    clauses.push("intervalSeconds = ?");
    params.push(args.intervalSeconds);
  }

  return ctx.storage.sql
    .exec<ScheduleRow>(
      `SELECT id, callback, payload, type, time, delayInSeconds, cron, intervalSeconds,
              running, execution_started_at, retry_options, created_at
       FROM cf_agents_schedules
       WHERE ${clauses.join(" AND ")}
       LIMIT 1`,
      ...params,
    )
    .next().value;
}

function getLatestScheduleIdFor(ctx: DurableObjectState, args: ScheduleLookupArgs) {
  const row = getExistingScheduleRow(ctx, args);
  return row?.id;
}

function createScheduleId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
