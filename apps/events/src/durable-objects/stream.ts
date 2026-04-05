import { DurableObject } from "cloudflare:workers";
import {
  type ChildStreamCreatedEvent,
  type DestroyStreamResult,
  type Event,
  Event as EventSchema,
  type EventInput,
  EventInput as EventInputSchema,
  type ProjectSlug,
  type StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import type { Schedule, ScheduleCriteria } from "./scheduling-types.ts";
import {
  applyBuiltinProcessorProjectionSync,
  createBuiltinProcessorInitialState,
  ensureBuiltinProcessorSchema,
  hydrateBuiltinProcessors,
  reduceBuiltinProcessorState,
  runBuiltinProcessorAlarm,
  runBuiltinProcessorAfterAppend,
  runBuiltinProcessorAfterCommit,
  runBuiltinProcessorBeforeAppend,
} from "~/durable-objects/processors/runtime.ts";
import {
  cancelScheduleOnStream,
  getScheduleFromStorage,
  getSchedulesFromStorage,
  scheduleEveryOnStream,
  scheduleOnStream,
} from "~/durable-objects/processors/scheduling/index.ts";
import {
  hydrateReducedStreamState,
  projectPublicStreamState,
  type ReducedStreamState,
} from "~/durable-objects/reduced-stream-state.ts";
import { getInitializedStreamStub, StreamOffsetPreconditionError } from "~/lib/stream-helpers.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";

/**
 * One stream per Durable Object: an append-only event log persisted in SQLite,
 * with a reduced in-memory projection and newline-delimited fanout for live
 * readers.
 *
 * ## Append lifecycle
 *
 * Every event passes through three phases that intentionally mirror the hooks
 * on `Processor` / `BuiltinProcessor` in `define-processor.ts`:
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
 * The stream core only owns structural invariants:
 * - initialization and durable storage
 * - offset sequencing and idempotency
 * - public history / live fanout
 * - parent-tree propagation
 *
 * Builtin processors own pluggable behavior layered on top of that core. They
 * may veto appends, reduce internal state, mirror query-optimized tables, and
 * react to alarms.
 *
 * The stream core itself has a handful of responsibilities that sit outside
 * the processor model entirely: initialization, storage, offset sequencing,
 * and parent-tree propagation. Those are structural invariants of the stream,
 * not pluggable behavior.
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
  private _state: ReducedStreamState | null = null;
  protected readonly _warnedScheduleInOnStart = new Set<string>();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private isInitializing = true;

  private get state(): ReducedStreamState {
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
        try {
          this._state = hydrateReducedStreamState({
            persistedStateJson: persistedStateRow.json,
            ctx: this.ctx,
          });
        } catch (error) {
          // Deliberately not crashing: throwing from the DO constructor makes
          // the object permanently unaddressable and much harder to debug.
          console.error(
            "[stream-do] persisted reduced_state failed validation, leaving _state null so initialize() can re-derive it",
            { error, raw: persistedStateRow.json },
          );
        }
      }

      if (this._state != null) {
        hydrateBuiltinProcessors({
          ctx: this.ctx,
          reducedState: this._state,
        });

        try {
          await this.append({
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
  async initialize(args: { projectSlug?: ProjectSlug; path: StreamPath }) {
    if (this._state != null) {
      return;
    }

    this.ensureSchema();
    const projectSlug =
      args.projectSlug ?? this.getProjectSlugFromCurrentName() ?? ("test" as ProjectSlug);

    this._state = {
      projectSlug,
      path: args.path,
      eventCount: 0,
      childPaths: [],
      metadata: {},
      processors: createBuiltinProcessorInitialState(),
      cf_agents_schedules: {},
    };

    try {
      await this.append({
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
  // The four methods below mirror the hook structure on BuiltinProcessor in
  // define-processor.ts.
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
    const parsedInputEvent = EventInputSchema.parse(inputEvent);

    if (parsedInputEvent.idempotencyKey != null) {
      const existingEvent = this.getEventByIdempotencyKey(parsedInputEvent.idempotencyKey);
      if (existingEvent != null) {
        return existingEvent;
      }
    }

    const nextOffset = this.beforeAppend(parsedInputEvent);

    const event = {
      streamPath: this.state.path,
      ...parsedInputEvent,
      offset: nextOffset,
      createdAt: new Date().toISOString(),
    };

    const nextState = reduceStreamState({ state: this.state, event });

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
      applyBuiltinProcessorProjectionSync({
        ctx: this.ctx,
        event,
      });
    });

    this._state = nextState;

    runBuiltinProcessorAfterCommit({
      append: this.append.bind(this),
      ctx: this.ctx,
      event,
      instance: this,
      state: this.state,
    });

    this.publish(event);
    this.propagateToAncestors(event);
    runBuiltinProcessorAfterAppend({
      append: this.append.bind(this),
      ctx: this.ctx,
      event,
      instance: this,
      state: this.state,
    });

    return event;
  }

  getState(): StreamState {
    return projectPublicStreamState(this.state)!;
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
      ...(path == null
        ? {}
        : { [path]: { finalState: projectPublicStreamState(stateBeforeDelete) } }),
    };

    return {
      destroyedStreamCount: Object.keys(finalStateByPath).length,
      finalStateByPath,
    };
  }

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

  async schedule<T = unknown>(
    when: Date | number | string,
    callback: keyof this | string,
    payload?: T,
    options?: { idempotent?: boolean },
  ): Promise<Schedule> {
    await this.ensureInitializedForCurrentName();

    return scheduleOnStream({
      when,
      callback,
      payload,
      options,
      deps: {
        append: this.append.bind(this),
        ctx: this.ctx,
        isInitializing: this.isInitializing,
        validateScheduleCallback: this.validateScheduleCallback.bind(this),
        warnedScheduleInOnStart: this._warnedScheduleInOnStart,
      },
    });
  }

  async scheduleEvery<T = unknown>(
    intervalSeconds: number,
    callback: keyof this | string,
    payload?: T,
    options?: { _idempotent?: boolean },
  ): Promise<Schedule> {
    await this.ensureInitializedForCurrentName();

    return scheduleEveryOnStream({
      intervalSeconds,
      callback,
      payload,
      options,
      deps: {
        append: this.append.bind(this),
        ctx: this.ctx,
        isInitializing: this.isInitializing,
        validateScheduleCallback: this.validateScheduleCallback.bind(this),
        warnedScheduleInOnStart: this._warnedScheduleInOnStart,
      },
    });
  }

  getSchedule(id: string): Schedule | undefined {
    return getScheduleFromStorage(this.ctx, id);
  }

  getSchedules(criteria: ScheduleCriteria = {}): Schedule[] {
    return getSchedulesFromStorage(this.ctx, criteria);
  }

  async cancelSchedule(id: string): Promise<boolean> {
    await this.ensureInitializedForCurrentName();

    return cancelScheduleOnStream({
      id,
      append: this.append.bind(this),
      ctx: this.ctx,
    });
  }

  async alarm() {
    await this.ensureInitializedForCurrentName();

    await runBuiltinProcessorAlarm({
      append: this.append.bind(this),
      ctx: this.ctx,
      instance: this,
      state: this.state,
    });
  }

  private async ensureInitializedForCurrentName() {
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
    await this.initialize({ projectSlug, path });
  }

  protected wasScheduleWarningEmitted(callback: string) {
    return this._warnedScheduleInOnStart.has(callback);
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

  /**
   * Validate-or-throw boundary. Enforces core invariants and runs builtin
   * processor gates before any state mutation occurs:
   *
   * 1. Core invariants: stream-initialized uniqueness, offset precondition.
   * 2. Builtin processor beforeAppend hooks (e.g. circuit-breaker rejection).
   *
   * Returns the next offset to use. Idempotency is handled by `append()`
   * before this method is called. By the time we get here, the input is known
   * to be a genuinely new event.
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

    runBuiltinProcessorBeforeAppend({
      event: input,
      instance: this,
      state: this.state,
    });

    return nextOffset;
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

  private ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        offset INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        metadata TEXT CHECK(metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reduced_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        json TEXT NOT NULL CHECK(json_valid(json))
      )
    `);
    ensureBuiltinProcessorSchema(this.ctx);
  }

  private getEventByIdempotencyKey(idempotencyKey: string) {
    const row = this.ctx.storage.sql
      .exec<SqliteEventRow>(
        `SELECT * FROM events WHERE idempotency_key = ? LIMIT 1`,
        idempotencyKey,
      )
      .next().value;

    return this.parseEventRow(row);
  }

  private parseEventRow(row: SqliteEventRow | null | undefined): Event | null {
    if (row == null) {
      return null;
    }

    return EventSchema.parse({
      streamPath: this.state.path,
      offset: row.offset,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: row.metadata == null ? undefined : JSON.parse(row.metadata),
      idempotencyKey: row.idempotency_key ?? undefined,
      createdAt: row.created_at,
    });
  }

  /**
   * Post-commit side effects, in order:
   *
   * 1. Subscriber fanout: push the committed event to all live pull-subscription
   *    readers connected via `stream()`.
   * 2. Core propagation: after `stream-initialized`, notify every ancestor
   *    stream with `child-stream-created` in parallel. This is a structural
   *    concern of the stream tree, not something a pluggable processor should own.
   * 3. Builtin processor hooks: processors may inspect the committed event and
   *    their state, then optionally append derived events back into this stream
   *    or schedule async alarm work.
   */
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

  private propagateToAncestors(event: Event) {
    if (event.type !== "https://events.iterate.com/events/stream/initialized") {
      return;
    }

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

function reduceStreamState(args: { state: ReducedStreamState; event: Event }): ReducedStreamState {
  const { state, event } = args;

  /**
   * Pure reduction: computes the next reduced stream state from the current
   * state and the committed event, without performing any I/O.
   */
  if (state.path !== event.streamPath) {
    throw new Error(
      `This should never happen. Somebody is trying to append an event to the wrong stream. Stream has path ${state.path}, but the event has path ${event.streamPath}.`,
    );
  }

  let nextState: ReducedStreamState = {
    ...structuredClone(state),
    eventCount: state.eventCount + 1,
  };

  switch (event.type) {
    case "https://events.iterate.com/events/stream/metadata-updated": {
      const metadataUpdatedEvent = event as StreamMetadataUpdatedEvent;
      nextState = { ...nextState, metadata: metadataUpdatedEvent.payload.metadata };
      break;
    }
    case "https://events.iterate.com/events/stream/child-stream-created": {
      const childPath = getImmediateChildPath({
        parentPath: state.path,
        childPath: (event as ChildStreamCreatedEvent).payload.childPath,
      });
      if (childPath != null && !nextState.childPaths.includes(childPath)) {
        nextState = { ...nextState, childPaths: [...nextState.childPaths, childPath] };
      }
      break;
    }
  }

  return reduceBuiltinProcessorState({
    event,
    state: nextState,
  });
}

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
