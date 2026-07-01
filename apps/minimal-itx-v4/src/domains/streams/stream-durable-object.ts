import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { itxEntrypointProps, itxEntrypointScopeCacheKey } from "../itx/utils.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import type {
  ProcessEventBatch,
  ProcessorRuntimeState,
  Stream,
  StreamEvent,
  StreamEventInput,
  StreamSubscriptionHandle,
  DynamicWorkerRef,
} from "../../types.ts";
import {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
} from "./schemas.ts";
import type { StreamSubscriberWakeRequest } from "./stream-processor-host.ts";
import { StreamSubscriptionRpcTarget } from "./subscription-handle.ts";
import { retainGetProcessorRuntimeState, retainProcessEventBatch } from "./rpc-lifecycle.ts";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  StreamSubscriberDescriptor as StreamSubscriberDescriptorSchema,
  type ConfiguredSubscriberDurableObjectType,
  type CoreProcessorState,
  type ConfiguredStreamSubscriber,
  type LiveStreamSubscriberDescriptor,
  type StreamSubscriberDescriptor,
  type StreamSubscriberDisconnectReason,
  type StreamSubscriptionType,
} from "./core-processor-contract.ts";

const StreamAppendInput = StreamEventInputSchema.extend({
  offset: z.number().int().nonnegative().optional(),
});

/**
 * Durable stream storage and Workers RPC surface.
 *
 * HTTP/WebSocket Cap'n Web termination belongs at the fronting Worker, which
 * exposes this DO through `StreamRpcTarget`.
 *
 * IMPORTANT: this class is deliberately NOT `implements Stream`.
 * `Stream` is the public async capability implemented by `StreamRpcTarget`.
 * The methods on this Durable Object are storage/runtime implementation
 * methods. The append/read methods that touch SQLite/KV directly must remain
 * synchronous so a stream append assigns offsets, reduces state, and persists
 * the batch in one await-free turn.
 */

// Cloudflare Durable Objects cap each SQLite string/blob/table row at 2 MB.
// BLOB columns do not raise that ceiling, and SQL-side substr(?) chunking would
// still require binding the oversized value first, so event JSON is chunked in JS.
const EVENT_CHUNK_SIZE = 512 * 1024;
const textEncoder = new TextEncoder();

// How long a stream may hold idle configured delivery connections before the
// Stream DO severs them so it (and its subscribers) can hibernate instead of
// accruing billable duration on cross-isolate RPC sessions that pin both DOs.
// Tracked with an in-memory timer (NOT a DO alarm): the retained stubs we tear
// down are in-memory and die on eviction anyway, the DO is always resident while
// it holds them (so the timer is guaranteed to fire), and a durable alarm's only
// extra power — waking a hibernated DO — is exactly what we must never do.
// Overridable via the STREAM_IDLE_TEARDOWN_MS env var (used by tests).
const DEFAULT_STREAM_IDLE_TEARDOWN_MS = 5 * 60_000;

type ConnectionRuntimeState = {
  subscriptionType: StreamSubscriptionType;
  startedAt: string;
  cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
};

type StreamDurableObjectRuntimeState = {
  coreProcessorState: CoreProcessorState;
  runtime: {
    connections: Record<string, ConnectionRuntimeState>;
  };
};

type ReducedCoreEvent = {
  event: StreamEvent;
  previousState: CoreProcessorState;
  state: CoreProcessorState;
};

type ProcessCoreEventArgs = ReducedCoreEvent & {
  runInBackground: (work: () => Promise<unknown>) => void;
};

type CoreSubscriptionArgs = {
  subscriptionKey: string;
  processEventBatch: ProcessEventBatch;
  replayAfterOffset?: number;
  eventTypes?: readonly string[];
  /** `false` = state-only batches. Default `true`. */
  events?: boolean;
  subscriber?: LiveStreamSubscriberDescriptor;
  onClose?: () => void;
};

export class StreamDurableObject extends DurableObject<Env> {
  readonly name = parseStreamDurableObjectName(this.ctx.id.name);

  #coreProcessorState: CoreProcessorState;
  /** In-memory idle teardown timer; armed only while configured connections exist. */
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Live delivery connections, keyed by subscriptionKey. Core reduced state
   * mirrors this map from subscriber-connected/disconnected facts, but the
   * callback stubs and pump cursors are incarnation-local runtime state.
   */
  #connections = new Map<string, Connection>();
  // subscriptionKeys with a configured subscriber wakeup in flight, so concurrent
  // reconciliation runs never wake the same subscriber twice.
  #connecting = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ensureStorageSchema();

    this.#coreProcessorState = this.readCoreProcessorState();

    // When the durable object boots up the _first time_, we add a
    // events.iterate.com/stream/created event to the stream.
    //
    // And every time it's woken up for any reason (fetch, RPC or alarm),
    // we append a "woken" event to the stream. The woken fact is also what
    // restores configured connections: the core processor's reconciler runs as
    // its post-commit side effect, so a stream that wakes with configured
    // subscriptions but no new appends still reconnects.
    if (this.#coreProcessorState.eventCount === 0) {
      this.append({
        type: "events.iterate.com/stream/created",
        payload: { projectId: this.name.projectId, path: this.name.path },
      });
    }
    // each time the durable object wakes up, we append this event
    this.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: crypto.randomUUID() },
    });
  }

  // Storage is normalized into two tables: `events` is the offset-ordered
  // metadata/index, and `event_chunks` holds the full event JSON as bounded
  // UTF-8 byte rows (Durable Object SQLite caps a cell at ~2 MB, so large events
  // are split; see EVENT_CHUNK_SIZE).
  #ensureStorageSchema(): void {
    this.ctx.storage.sql.exec(`
      -- Stream-owned append log metadata. Full event JSON is stored in event_chunks.
      -- offset is the replay cursor; idempotency_key's unique constraint is its lookup index.
      create table if not exists events (
        offset integer primary key autoincrement,
        type text not null,
        created_at text not null,
        idempotency_key text unique
      )
    `);
    this.ctx.storage.sql.exec(`
      -- Full committed event JSON split into ordered byte chunks. The WITHOUT ROWID
      -- primary key is the lookup index used by point reads and range replay.
      create table if not exists event_chunks (
        offset integer not null,
        chunk_index integer not null,
        chunk_bytes blob not null,
        primary key (offset, chunk_index),
        foreign key (offset) references events(offset) on delete cascade
      ) without rowid
    `);
  }

  protected readCoreProcessorState(): CoreProcessorState {
    const stored = this.ctx.storage.kv.get<unknown>("state");
    const storedVersion = this.ctx.storage.kv.get<unknown>("stateVersion") ?? 1;
    // State persisted by a reducer of a different version is incomplete (it
    // was reduced before newer derived fields existed), so it is discarded and
    // rebuilt from the event log rather than trusted.
    const storedStateIsCurrent = stored !== undefined && storedVersion === CORE_STATE_VERSION;
    const storedState = storedStateIsCurrent
      ? CoreProcessorContract.stateSchema.parse(stored)
      : this.#recoverCoreProcessorStateFromEventLog();
    if (storedState === undefined) return CoreProcessorContract.stateSchema.parse({});

    const state = this.#catchUpCoreProcessorState(storedState);

    if (!storedStateIsCurrent || state.maxOffset !== storedState.maxOffset) {
      this.writeCoreProcessorState(state);
    }
    return state;
  }

  protected writeCoreProcessorState(state: CoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
    this.ctx.storage.kv.put("stateVersion", CORE_STATE_VERSION);
  }

  #catchUpCoreProcessorState(state: CoreProcessorState): CoreProcessorState {
    const highestOffset = this.#readHighestEventOffset();
    if (highestOffset <= state.maxOffset) return state;

    return this.#reduceCoreProcessorState({
      state,
      events: this.#readEventsInRange({
        afterOffset: state.maxOffset,
        beforeOffset: highestOffset + 1,
        limit: highestOffset - state.maxOffset,
      }),
    });
  }

  #readHighestEventOffset(): number {
    return (
      this.ctx.storage.sql
        .exec<{ offset: number | null }>("select max(offset) as offset from events")
        .toArray()[0]?.offset ?? 0
    );
  }

  #appendEventRows(events: StreamEvent[]): void {
    for (const event of events) {
      const rawJson = JSON.stringify(event);
      this.ctx.storage.sql.exec(
        `
          insert into events (offset, type, created_at, idempotency_key)
          values (?, ?, ?, ?)
        `,
        event.offset,
        event.type,
        event.createdAt,
        event.idempotencyKey ?? null,
      );
      this.#insertEventChunks(event.offset, rawJson);
    }
  }

  #insertEventChunks(offset: number, rawJson: string): void {
    const rawJsonBytes = textEncoder.encode(rawJson);
    for (const [chunkIndex, chunk] of chunkBytes(rawJsonBytes, EVENT_CHUNK_SIZE)) {
      this.ctx.storage.sql.exec(
        `
          insert into event_chunks (offset, chunk_index, chunk_bytes)
          values (?, ?, ?)
        `,
        offset,
        chunkIndex,
        chunk,
      );
    }
  }

  #readEventByOffset(offset: number): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ offset: number }>(
        `
          select offset
          from events
          where offset = ?
          limit 1
        `,
        offset,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return this.#readEventFromChunks(row.offset);
  }

  #readEventByIdempotencyKey(idempotencyKey: string): StreamEvent | undefined {
    const row = this.ctx.storage.sql
      .exec<{ offset: number }>(
        `
          select offset
          from events
          where idempotency_key = ?
          limit 1
        `,
        idempotencyKey,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return this.#readEventFromChunks(row.offset);
  }

  #readEventFromChunks(offset: number): StreamEvent {
    // Do not use group_concat here: it would recreate a multi-MiB SQLite result cell.
    // Returning bounded chunk rows and joining in JS keeps SQLite row sizes predictable.
    const chunks = this.ctx.storage.sql
      .exec<{ chunkBytes: ArrayBuffer }>(
        `
          select chunk_bytes as chunkBytes
          from event_chunks
          where offset = ?
          order by chunk_index asc
        `,
        offset,
      )
      .toArray()
      .map((row) => row.chunkBytes);
    const rawJson = decodeChunks(chunks);
    return StreamEventSchema.parse(JSON.parse(rawJson));
  }

  #readEventsInRange(args: {
    afterOffset: number;
    beforeOffset: number;
    limit: number;
  }): StreamEvent[] {
    // One indexed metadata subquery picks the replay window; the join then streams each
    // event's chunks in primary-key order (offset, chunk_index).
    const chunks = this.ctx.storage.sql
      .exec<{ offset: number; chunkBytes: ArrayBuffer }>(
        `
          select selected.offset as offset, event_chunks.chunk_bytes as chunkBytes
          from (
            select offset
            from events
            where offset > ?
              and offset < ?
            order by offset asc
            limit ?
          ) selected
          join event_chunks on event_chunks.offset = selected.offset
          order by selected.offset asc, event_chunks.chunk_index asc
        `,
        args.afterOffset,
        args.beforeOffset,
        args.limit,
      )
      .toArray();
    const chunksByOffset = new Map<number, ArrayBuffer[]>();
    for (const chunk of chunks) {
      const eventChunks = chunksByOffset.get(chunk.offset);
      if (eventChunks === undefined) {
        chunksByOffset.set(chunk.offset, [chunk.chunkBytes]);
      } else {
        eventChunks.push(chunk.chunkBytes);
      }
    }
    return [...chunksByOffset.values()].map((eventChunks) =>
      StreamEventSchema.parse(JSON.parse(decodeChunks(eventChunks))),
    );
  }

  #recoverCoreProcessorStateFromEventLog(): CoreProcessorState | undefined {
    const events = this.#readEventsInRange({
      afterOffset: 0,
      beforeOffset: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    });
    if (events.length === 0) return undefined;

    // KV state is the fast path, but SQL rows are the durable source of truth.
    // If a deployed DO has rows but no KV state, replay the event log instead of
    // treating the stream as empty and trying to insert offset 1 again.
    return this.#reduceCoreProcessorState({
      state: CoreProcessorContract.stateSchema.parse({}),
      events,
    });
  }

  #reduceCoreProcessorState(args: {
    state: CoreProcessorState;
    events: readonly StreamEvent[];
  }): CoreProcessorState {
    let state = args.state;
    for (const event of args.events) {
      if (event.offset <= state.maxOffset) continue;
      state = this.#reduceCoreEvent({ event, state });
    }
    return state;
  }

  /**
   * Pre-append gate, called before an event is committed. This is stream-owned
   * policy, not a hosted processor hook: only the stream itself can reject an
   * append based on core state.
   */
  #validateCoreAppend(args: { event: StreamEventInput; state: CoreProcessorState }): void {
    if (args.event.type === "events.iterate.com/stream/subscription-configured") {
      // Configured subscriptions are durable desired state. Once this event is
      // committed, the reducer stores it in `configuredSubscribersByKey` and the
      // stream is allowed to re-wake that subscriber forever. That means target
      // validation must happen here, before offset assignment and storage, not
      // inside the later fire-and-forget wake path.
      //
      // The safety problem this prevents:
      // 1. A project-scoped stream accepts a configured subscriber whose Durable
      //    Object address belongs to another project.
      // 2. Append succeeds, so the bad target becomes durable stream state.
      // 3. Wake fails or logs later, but future appends keep reconciling the
      //    same invalid configured subscriber.
      //
      // The lifecycle tests that pin this are:
      // - "configured durable object subscribers must target the stream project"
      // - "global streams reject project-scoped configured durable object subscribers"
      // - "global streams reject configured worker subscribers"
      // Each one also asserts the rejected event was not committed.
      const event = CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        args.event,
      );
      this.#validateConfiguredSubscriberTarget(event.payload.subscriber);
    }

    if (args.event.type === "events.iterate.com/stream/rule-configured") {
      const event = CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/rule-configured",
        args.event,
      );
      this.#validateStreamRuleTarget(event.payload);
    }

    if (!args.state.paused) return;

    // Presence facts pass through the pause door alongside resume/error/woken:
    // a paused stream still has subscribers attaching (e.g. an operator's
    // browser), and the roster must stay truthful for the stream to recover.
    switch (args.event.type) {
      case "events.iterate.com/stream/resumed":
      case "events.iterate.com/stream/error-occurred":
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscriber-connected":
      case "events.iterate.com/stream/subscriber-disconnected":
        return;
      default:
        throw new Error(`stream paused: ${args.state.pauseReason ?? "unknown reason"}`);
    }
  }

  // Reduce is on the synchronous DO append hot path and runs per event. Known
  // core event payloads are parsed from CoreProcessorContract before state
  // access; non-core events still count toward the stream offset/event counters.
  //
  // Do NOT re-parse the whole state on the way out: `state` was already
  // validated at the trust boundary (the KV read and event-log recovery path
  // both parse). Re-validating the growing connectionsByKey/processorsBySlug/
  // configuredSubscribersByKey records on every append was quadratic work for
  // no added safety.
  #reduceCoreEvent(args: { event: StreamEvent; state: CoreProcessorState }): CoreProcessorState {
    const state = args.state;
    let next: CoreProcessorState = {
      ...state,
      eventCount: state.eventCount + 1,
      maxOffset: args.event.offset,
    };

    switch (args.event.type) {
      case "events.iterate.com/stream/paused": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/paused",
          args.event,
        );
        next = {
          ...next,
          paused: true,
          pauseReason: event.payload.reason ?? null,
        };
        break;
      }

      case "events.iterate.com/stream/resumed":
        CoreProcessorContract.parseEvent("events.iterate.com/stream/resumed", args.event);
        next = {
          ...next,
          paused: false,
          pauseReason: null,
        };
        break;

      case "events.iterate.com/stream/created": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/created",
          args.event,
        );
        if (event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        next = {
          ...next,
          projectId: event.payload.projectId,
          path: event.payload.path,
          createdAt: event.createdAt,
        };
        break;
      }

      case "events.iterate.com/stream/woken": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/woken",
          args.event,
        );
        // A new stream incarnation means every previous delivery connection
        // died with the old one. Clearing the roster here is what keeps it
        // truthful without heartbeats: surviving subscribers reconnect and
        // their fresh subscriber-connected events re-land below.
        next = {
          ...next,
          incarnationId: event.payload.incarnationId,
          connectionsByKey: {},
        };
        break;
      }

      case "events.iterate.com/stream/subscriber-connected": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscriber-connected",
          args.event,
        );
        const { subscriptionKey, subscriber, subscriptionType } = event.payload;
        next = {
          ...next,
          connectionsByKey: {
            ...next.connectionsByKey,
            [subscriptionKey]: {
              subscriptionType,
              connectedAtOffset: event.offset,
              ...(subscriber === undefined ? {} : { subscriber }),
            },
          },
        };
        // A processor announcement on the connect event feeds the stream's
        // contract documentation registry. The subscriber was validated by the
        // descriptor schema when the connect event was parsed above, so the
        // announcement (when present) is already well-formed.
        const announcement = subscriber?.processor?.announcement;
        if (announcement !== undefined) {
          next = {
            ...next,
            processorsBySlug: {
              ...next.processorsBySlug,
              [announcement.slug]: {
                announcedAtOffset: event.offset,
                announcement,
              },
            },
          };
        }
        break;
      }

      case "events.iterate.com/stream/subscriber-disconnected": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscriber-disconnected",
          args.event,
        );
        const { [event.payload.subscriptionKey]: _closed, ...connectionsByKey } =
          next.connectionsByKey;
        next = { ...next, connectionsByKey };
        break;
      }

      case "events.iterate.com/stream/metadata-updated": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/metadata-updated",
          args.event,
        );
        next = {
          ...next,
          metadata: event.payload.metadata,
        };
        break;
      }

      case "events.iterate.com/stream/child-stream-created": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/child-stream-created",
          args.event,
        );
        if (state.path === undefined) break;
        const announcedPath = event.payload.childPath;
        let childPath: string | null;
        if (announcedPath === state.path) {
          childPath = null;
        } else if (state.path === "/") {
          const [firstSegment] = announcedPath.split("/").filter(Boolean);
          childPath = firstSegment === undefined ? null : `/${firstSegment}`;
        } else {
          const parentPrefix = `${state.path}/`;
          if (!announcedPath.startsWith(parentPrefix)) {
            childPath = null;
          } else {
            const [firstSegment] = announcedPath
              .slice(parentPrefix.length)
              .split("/")
              .filter(Boolean);
            childPath = firstSegment === undefined ? null : `${state.path}/${firstSegment}`;
          }
        }

        if (childPath !== null && !next.childPaths.includes(childPath)) {
          next = { ...next, childPaths: [...next.childPaths, childPath] };
        }
        break;
      }

      case "events.iterate.com/stream/subscription-configured": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-configured",
          args.event,
        );
        next = {
          ...next,
          configuredSubscribersByKey: {
            ...next.configuredSubscribersByKey,
            [event.payload.subscriptionKey]: {
              latestConfiguredEvent: {
                offset: event.offset,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt,
              },
            },
          },
        };
        break;
      }

      case "events.iterate.com/stream/subscription-removed": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/subscription-removed",
          args.event,
        );
        const { [event.payload.subscriptionKey]: _removed, ...configuredSubscribersByKey } =
          next.configuredSubscribersByKey;
        next = { ...next, configuredSubscribersByKey };
        break;
      }

      case "events.iterate.com/stream/rule-configured": {
        const event = CoreProcessorContract.parseEvent(
          "events.iterate.com/stream/rule-configured",
          args.event,
        );
        next = {
          ...next,
          rulesById: {
            ...next.rulesById,
            [event.payload.ruleId]: {
              latestConfiguredEvent: {
                offset: event.offset,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt,
              },
            },
          },
        };
        break;
      }

      case "events.iterate.com/stream/error-occurred":
        CoreProcessorContract.parseEvent("events.iterate.com/stream/error-occurred", args.event);
        break;

      default:
        break;
    }
    return next;
  }

  /**
   * Run stream-owned post-commit side effects for one already-reduced event.
   * Historical catch-up only reduces state; it does not replay side effects.
   */
  #processReducedCoreEvent(args: ReducedCoreEvent): void {
    this.#processCoreEvent({
      event: args.event,
      previousState: args.previousState,
      state: args.state,
      runInBackground: (work) => this.runCoreProcessorInBackground(work),
    });
  }

  #processCoreEvent(args: ProcessCoreEventArgs): undefined {
    switch (args.event.type) {
      case "events.iterate.com/stream/woken":
      case "events.iterate.com/stream/subscription-configured":
      case "events.iterate.com/stream/subscription-removed":
        this.#reconcileConnections();
        return;
      case "events.iterate.com/stream/rule-configured":
        return;
      case "events.iterate.com/stream/created":
        this.#announceToAncestors(args);
        return;
      default:
        this.#crossPostMatchingRules(args);
        return;
    }
  }

  #announceToAncestors(args: ProcessCoreEventArgs): void {
    const path = args.state.path;
    if (path === undefined || path === "/") return;

    const pathSegments = path.split("/").filter(Boolean);
    const ancestorPaths = ["/"];
    for (let index = 1; index < pathSegments.length; index += 1) {
      ancestorPaths.push(`/${pathSegments.slice(0, index).join("/")}`);
    }

    args.runInBackground(async () => {
      await Promise.all(
        ancestorPaths.map((ancestorPath) =>
          this.appendToStreamPath(ancestorPath, {
            type: "events.iterate.com/stream/child-stream-created",
            idempotencyKey: `child-stream-created:${ancestorPath}:${path}`,
            payload: { childPath: path },
          }),
        ),
      );
    });
  }

  #crossPostMatchingRules(args: ProcessCoreEventArgs): void {
    if (args.event.source?.crossPost !== undefined) return;

    const matchingRules = Object.values(args.state.rulesById).filter(({ latestConfiguredEvent }) =>
      latestConfiguredEvent.payload.eventTypes.includes(args.event.type),
    );
    if (matchingRules.length === 0) return;

    const sourceProjectId = args.state.projectId ?? this.name.projectId;
    const sourcePath = args.state.path ?? this.name.path;

    args.runInBackground(async () => {
      await Promise.all(
        matchingRules.map(({ latestConfiguredEvent }) => {
          const rule = latestConfiguredEvent.payload;
          const { createdAt, offset, ...copy } = args.event;
          return this.#appendToStreamCoordinate(
            {
              path: rule.path,
              projectId: rule.projectId === undefined ? this.name.projectId : rule.projectId,
            },
            {
              ...copy,
              source: {
                ...copy.source,
                crossPost: {
                  ruleId: rule.ruleId,
                  from: {
                    createdAt,
                    offset,
                    path: sourcePath,
                    projectId: sourceProjectId,
                    type: args.event.type,
                  },
                },
              },
              idempotencyKey: `cross-post:${rule.ruleId}:${sourceProjectId ?? "global"}:${sourcePath}:${offset}`,
            },
          );
        }),
      );
    });
  }

  /**
   * Synchronously assigns offsets, reduces, persists, then wakes delivery.
   *
   * DO NOT make this method async. Do not insert an `await` anywhere in the
   * offset/reduce/persist path it calls. This is the stream's commit point:
   * storage writes and core state changes must happen in one synchronous turn.
   *
   * What actually happens for `append(a, b)` on a stream at `maxOffset: 4`:
   * 1. `a` becomes offset 5, `b` becomes offset 6; each is folded into reduced state.
   *    An event whose `idempotencyKey` already exists is skipped and the existing
   *    event is returned in its place (so the returned array stays input-aligned).
   * 2. Event rows + the new core processor state are written in one await-free turn.
   *    After this line the append has succeeded.
   * 3. Post-commit fan-out: every live connection's `wake()` is called (its pump then
   *    reads offsets 5..6 from storage and delivers them); core post-commit work may
   *    reconcile configured subscriptions. Neither can fail the append.
   *
   * Returns the persisted events (including offsets + `createdAt`) in input order.
   */
  append(...eventInputs: StreamEventInput[]): StreamEvent[] {
    let workingCoreProcessorState = this.#coreProcessorState;
    const events: StreamEvent[] = [];
    const newEvents: StreamEvent[] = [];
    const postCommitCoreEvents: Array<{
      event: StreamEvent;
      previousState: CoreProcessorState;
      state: CoreProcessorState;
    }> = [];
    const idempotencyHitsInBatch = new Map<string, StreamEvent>();
    // 1. Prepare events and reduced state.
    for (const eventInput of eventInputs) {
      // `offset` is an optional optimistic-concurrency assertion, not part of the
      // event body. Split it off immediately so it never reaches core-event
      // validation or the committed event: the pre-commit gate strict-parses the
      // body against the contract schema, which has no `offset` key, so leaving it
      // attached made every asserted append of a core policy event
      // (subscription-configured, rule-configured) fail with a spurious
      // "Unrecognized key: offset" instead of performing the assertion.
      const { offset: expectedOffset, ...body } = StreamAppendInput.strict().parse(eventInput);

      if (body.idempotencyKey !== undefined) {
        // Same-batch idempotency should behave like already-persisted idempotency.
        const existing =
          idempotencyHitsInBatch.get(body.idempotencyKey) ??
          this.getEvent({ idempotencyKey: body.idempotencyKey });
        if (existing !== undefined) {
          if (expectedOffset !== undefined && expectedOffset !== existing.offset) {
            throw new Error(`idempotency hit at offset ${existing.offset}, got ${expectedOffset}`);
          }
          events.push(existing);
          continue;
        }
      }

      this.#validateCoreAppend({
        event: body,
        state: workingCoreProcessorState,
      });

      const committed: StreamEvent = {
        ...body,
        offset: workingCoreProcessorState.maxOffset + 1,
        createdAt: new Date().toISOString(),
      };
      if (expectedOffset !== undefined && expectedOffset !== committed.offset) {
        throw new Error(`expected offset ${committed.offset}, got ${expectedOffset}`);
      }

      const previousCoreProcessorState = workingCoreProcessorState;
      workingCoreProcessorState = this.#reduceCoreEvent({
        event: committed,
        state: previousCoreProcessorState,
      });

      // Core post-commit work is deferred until after the commit below:
      // announcing ancestors and reconciling delivery can call back into stream
      // runtime state, so running it mid-batch would observe stale
      // `this.#coreProcessorState`.
      postCommitCoreEvents.push({
        event: committed,
        previousState: previousCoreProcessorState,
        state: workingCoreProcessorState,
      });

      events.push(committed);
      newEvents.push(committed);
      if (committed.idempotencyKey !== undefined) {
        idempotencyHitsInBatch.set(committed.idempotencyKey, committed);
      }
    }

    if (newEvents.length === 0) return events;

    // 2. Persist new event rows and reduced core processor state.
    // Durable Object SQL storage runs synchronously in the object's thread. The
    // first-party docs say each sql.exec() call is atomic, cursors should be fully
    // consumed before awaits, and Output Gates hold responses until writes are durable:
    // https://developers.cloudflare.com/durable-objects/api/sql-storage/
    // https://blog.cloudflare.com/sqlite-in-durable-objects/
    //
    // Keep this section await-free: event rows + core processor state are the append boundary.
    this.#appendEventRows(newEvents);
    this.writeCoreProcessorState(workingCoreProcessorState);
    this.#coreProcessorState = workingCoreProcessorState;

    // Post-commit core side effects (see the deferral note above). Inline core
    // side effects are fire-and-forget (`runInBackground`), so this cannot fail
    // the append.
    for (const reduced of postCommitCoreEvents) {
      this.#processReducedCoreEvent(reduced);
    }

    // 3. Wake live delivery. Append success is already decided above — this is
    // pure post-commit fan-out. (Connection reconciliation is not triggered
    // here: it is the core processor's side effect for the woken and
    // subscription-configured facts, which ran in the loop above.)
    this.#wakeConnections();

    // Re-wake any configured subscription left without a live connection — e.g.
    // an idle teardown (here or on the subscriber), a clean unsubscribe, etc.
    // severed it. The subscriber re-handshakes from its durable checkpoint, so
    // replay covers this very event. Cheap (O(subscriptions)) and a no-op once
    // everything is connected.
    //
    // Exactly ONE event type is excluded as a re-wake trigger:
    // `subscriber-disconnected`. `connection.close()` appends one as it removes
    // the connection from the map, so at that instant `needsConfiguredReconcile()`
    // is transiently true for the just-closed key — reconciling on it would
    // immediately re-wake and undo every teardown (idle / unsubscribed /
    // replaced / …). Re-wake must wait for the next genuine append. Every OTHER
    // event is safe to trigger on: `woken` and `subscription-configured` have
    // already reconciled via the core's reduced-event side effect (so the check
    // is a no-op), and `subscriber-connected` only lands while its key is
    // connected/connecting (also a no-op). We deliberately do NOT exclude the
    // whole `stream/*` event family — only this single self-undoing event.
    const SUBSCRIBER_DISCONNECTED_TYPE = "events.iterate.com/stream/subscriber-disconnected";
    const hasRewakeTriggeringAppend = newEvents.some(
      (event) => event.type !== SUBSCRIBER_DISCONNECTED_TYPE,
    );
    if (hasRewakeTriggeringAppend && this.#needsConfiguredReconcile()) {
      this.#reconcileConnections();
    }

    // Re-arm (or clear) the in-memory idle timer against the post-append
    // connection set, so a stream that just went quiet sheds its configured
    // delivery sessions and lets both DOs hibernate.
    this.#armOrClearIdleTimer();

    return events;
  }

  #appendToStreamCoordinate(
    coordinate: { projectId: string | null; path: string },
    ...events: StreamEventInput[]
  ) {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify(coordinate, { allowNullProjectId: true }),
    ).append(...events);
  }

  appendToStreamPath(path: string, ...events: StreamEventInput[]) {
    return this.#appendToStreamCoordinate({ path, projectId: this.name.projectId }, ...events);
  }

  runCoreProcessorInBackground(work: () => Promise<unknown>): void {
    let promise: Promise<unknown>;
    try {
      promise = work();
    } catch (error) {
      console.error("stream core background work failed", error);
      return;
    }

    this.ctx.waitUntil(promise);
    void promise.catch((error: unknown) => {
      console.error("stream core background work failed", error);
    });
  }

  /**
   * Synchronous committed-event read used by the append transaction and
   * delivery catch-up. Keep await-free; callers that cross an RPC seam get the
   * async shape from `StreamRpcTarget`, not from this storage method.
   */
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined {
    if (args.idempotencyKey !== undefined) {
      return this.#readEventByIdempotencyKey(args.idempotencyKey);
    }
    return this.#readEventByOffset(args.offset);
  }

  /**
   * Synchronous committed-event range read. Keep await-free so append,
   * delivery, and state rebuild code can consume stream storage without
   * yielding in the middle of stream-owned invariants.
   */
  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      limit?: number;
    } = {},
  ): StreamEvent[] {
    const limit = args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("getEvents limit must be a positive integer.");
    }

    // Later this should accept event type filters for subscription catch-up and
    // operator views. Keep the first SQLite shape offset-only until that design is real.
    return this.#readEventsInRange({
      afterOffset: args.afterOffset ?? 0,
      beforeOffset: args.beforeOffset ?? Number.MAX_SAFE_INTEGER,
      limit: limit ?? Number.MAX_SAFE_INTEGER,
    });
  }

  /** Re-arm every live connection's delivery pump after a commit. */
  #wakeConnections(): void {
    for (const connection of this.#connections.values()) connection.wake();
  }

  /** True if any live connection belongs to a configured, wakeable subscriber. */
  #hasLiveConfiguredConnections(): boolean {
    for (const connection of this.#connections.values()) {
      if (connection.subscriptionType === "configured") return true;
    }
    return false;
  }

  /**
   * Deliberately drops every live configured delivery connection so a quiet stream
   * stops pinning subscriber DOs with idle cross-isolate RPC sessions. The
   * durable subscription config is kept, so the next append re-wakes.
   */
  #closeIdleConfiguredConnections(): string[] {
    const severed: string[] = [];
    // Snapshot first: close() mutates #connections.
    for (const [subscriptionKey, connection] of [...this.#connections]) {
      if (connection.subscriptionType !== "configured") continue;
      severed.push(subscriptionKey);
      connection.close("idle");
    }
    return severed;
  }

  /**
   * True if a configured subscription currently has no live or in-flight
   * connection and needs re-waking.
   */
  #needsConfiguredReconcile(): boolean {
    for (const subscriptionKey of Object.keys(
      this.#coreProcessorState.configuredSubscribersByKey,
    )) {
      const connection = this.#connections.get(subscriptionKey);
      if (connection?.subscriptionType !== "configured" && !this.#connecting.has(subscriptionKey)) {
        return true;
      }
    }
    return false;
  }

  /** Serializable debug view of the live connections, for runtimeState(). */
  #connectionsRuntimeState(): Record<string, ConnectionRuntimeState> {
    return Object.fromEntries(
      [...this.#connections].map(([subscriptionKey, connection]) => [
        subscriptionKey,
        {
          subscriptionType: connection.subscriptionType,
          startedAt: connection.startedAt,
          cursor: connection.cursor,
          batchesSent: connection.batchesSent,
          eventsSent: connection.eventsSent,
          lastDeliveredAt: connection.lastDeliveredAt,
        },
      ]),
    );
  }

  async #getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(args.subscriptionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  /** Fire-and-forget configured subscriber reconciliation; never blocks append. */
  #reconcileConnections(): void {
    try {
      this.#reconcileConfiguredConnections();
    } catch (error) {
      console.error("Stream configured subscriber reconciliation failed", error);
    }
  }

  /**
   * Makes runtime configured connections match the persisted subscription config:
   * closes connections whose config disappeared, wakes a subscriber for each
   * configured subscription that has none. Triggered by woken/config changes and
   * by configured connection loss, never per append.
   */
  #reconcileConfiguredConnections(): void {
    const state = this.#coreProcessorState;
    for (const [subscriptionKey, connection] of this.#connections) {
      if (
        connection.subscriptionType === "configured" &&
        state.configuredSubscribersByKey[subscriptionKey] === undefined
      ) {
        connection.close("subscription-removed");
      }
    }

    for (const [subscriptionKey, configured] of Object.entries(state.configuredSubscribersByKey)) {
      const connection = this.#connections.get(subscriptionKey);
      if (connection?.subscriptionType === "configured" || this.#connecting.has(subscriptionKey)) {
        continue;
      }

      // Reserve the key before any await so a concurrent reconcile can't wake twice.
      this.#connecting.add(subscriptionKey);
      this.runCoreProcessorInBackground(async () => {
        try {
          await this.wakeConfiguredSubscriber({ configured, subscriptionKey });
        } catch (error) {
          console.error("Stream configured subscriber wakeup failed", { error, subscriptionKey });
        } finally {
          this.#connecting.delete(subscriptionKey);
        }
      });
    }
  }

  #startSubscription(
    args: CoreSubscriptionArgs & { subscriptionType: StreamSubscriptionType },
  ): StreamSubscriptionHandle {
    const subscriptionKey = args.subscriptionKey.trim();
    if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");

    // Validate the caller-supplied descriptor at the boundary. The public
    // `Stream.subscribe` contract types `subscriber` as `unknown`, so without
    // this check a malformed descriptor would only fail later, deep inside the
    // reducer, while appending the `subscriber-connected` presence fact. That
    // append is wrapped in a catch-and-log, so the connection would already be
    // live and delivering with NO entry on the presence roster — the runtime
    // connection map and its event-sourced mirror would silently disagree.
    // Parsing the serializable projection here rejects the subscribe call before
    // any connection is registered. The live `getRuntimeState` capability is not
    // part of the serializable descriptor and is preserved separately below.
    const presenceDescriptor =
      args.subscriber === undefined ? undefined : serializableSubscriber(args.subscriber);

    // Replacing any existing connection for this key.
    this.#connections.get(subscriptionKey)?.close("replaced");

    // Optional event-type filter. The cursor still advances past non-matching
    // events; they are skipped, not deferred.
    const eventTypeFilter =
      args.eventTypes === undefined || args.eventTypes.includes("*")
        ? undefined
        : new Set(args.eventTypes);

    const deliverEvents = args.events !== false;
    // State-only subscriptions are implicitly live-from-now: replay without
    // events is meaningless, so replayAfterOffset is ignored in that mode.
    let cursor = deliverEvents
      ? (args.replayAfterOffset ?? this.#coreProcessorState.maxOffset)
      : this.#coreProcessorState.maxOffset;
    let initialBatchPending = true;
    let draining = false;
    let open = true;

    const processEventBatch = retainProcessEventBatch(
      args.processEventBatch,
      args.subscriptionType === "configured"
        ? {
            onDeliveryError: (error) => {
              if (!open) return;
              console.error("Stream event batch delivery failed; dropping connection for re-wake", {
                subscriptionKey,
                subscriptionType: args.subscriptionType,
                error,
              });
              connection.close("delivery-failed");
              this.#reconcileConnections();
            },
          }
        : {},
    );

    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          if (deliverEvents) {
            const readEvents = this.getEvents({ afterOffset: cursor, limit: 100 }); // limit hardcoded for now
            const lastOffset = readEvents.at(-1)?.offset;
            if (lastOffset === undefined) {
              // Caught up; the next append wakes us again. The first drain
              // still owes the initial state batch.
              if (!initialBatchPending) return;
            } else {
              cursor = lastOffset;
              events =
                eventTypeFilter === undefined
                  ? readEvents
                  : readEvents.filter((event) => eventTypeFilter.has(event.type));
              if (events.length === 0 && !initialBatchPending) continue;
            }
          } else {
            const stateMaxOffset = this.#coreProcessorState.maxOffset;
            if (stateMaxOffset <= cursor && !initialBatchPending) return;
            cursor = stateMaxOffset;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.lastDeliveredAt = new Date().toISOString();
          const currentState = this.#coreProcessorState;
          if (currentState.projectId === undefined || currentState.path === undefined) {
            throw new Error(
              "Cannot deliver stream batch before stream coordinates are initialized.",
            );
          }
          processEventBatch({
            projectId: currentState.projectId,
            path: currentState.path,
            events,
            streamMaxOffset: currentState.maxOffset,
            // Read in the same synchronous block as streamMaxOffset, so the
            // two always correspond (state-at-streamMaxOffset; see types.ts).
            state: currentState,
          });
          await Promise.resolve();
        }
      } finally {
        draining = false;
      }
    };

    const connection: Connection = {
      subscriptionType: args.subscriptionType,
      startedAt: new Date().toISOString(),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(
        args.subscriber?.processor?.getRuntimeState,
      ),
      get cursor() {
        return cursor;
      },
      batchesSent: 0,
      eventsSent: 0,
      wake: () => void pump(),
      close: (reason) => {
        if (!open) return;
        open = false;
        if (this.#connections.get(subscriptionKey) === connection) {
          this.#connections.delete(subscriptionKey);
        }
        processEventBatch[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        this.#appendPresenceFact({
          type: "events.iterate.com/stream/subscriber-disconnected",
          payload: { subscriptionKey, reason },
        });
        args.onClose?.();
      },
    };

    this.#connections.set(subscriptionKey, connection);
    // The presence fact lands after the connection is registered and after the
    // replay cursor is fixed, so connected is the tail of any first batch it
    // shares with replayed events.
    this.#appendPresenceFact({
      type: "events.iterate.com/stream/subscriber-connected",
      payload: {
        subscriptionKey,
        subscriptionType: args.subscriptionType,
        ...(presenceDescriptor === undefined ? {} : { subscriber: presenceDescriptor }),
      },
    });
    processEventBatch.onRpcBroken?.(() => {
      connection.close("rpc-broken");
      if (args.subscriptionType === "configured") this.#reconcileConnections();
    });
    connection.wake();

    return new StreamSubscriptionRpcTarget({
      close: () => connection.close("unsubscribed"),
      subscriptionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
    });
  }

  /**
   * Presence facts are observations appended exactly once per actual open/close,
   * so they carry no idempotency keys. Close paths run during teardown where an
   * append can fail; that must never mask the close itself, so failures log.
   */
  #appendPresenceFact(event: StreamEventInput): void {
    try {
      this.append(event);
    } catch (error) {
      console.error("stream presence fact append failed", { type: event.type, error });
    }
  }

  /**
   * One-shot convenience over `subscribe()`: replay from the requested cursor,
   * then live-tail until a caller predicate accepts an event.
   *
   * This is intentionally not a durable waiter. If the RPC caller or this DO
   * incarnation dies, the wait dies too; callers that need retry semantics
   * should call again with the same `afterOffset`.
   */
  async waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]): Promise<StreamEvent> {
    if (args.eventTypes === undefined && args.predicate === undefined) {
      throw new Error("waitForEvent requires eventTypes or predicate.");
    }
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new Error("waitForEvent timeoutMs must be a positive number.");
    }
    if (
      args.afterOffset !== undefined &&
      (!Number.isInteger(args.afterOffset) || args.afterOffset < 0)
    ) {
      throw new Error("waitForEvent afterOffset must be a non-negative integer.");
    }

    const predicate = args.predicate ?? (() => true);
    const found = Promise.withResolvers<StreamEvent>();

    // Bound the memory a long wait on a busy stream can hold: keep a count and a
    // small ring of recent types for the timeout message rather than every seen
    // event (events can be multi-megabyte).
    let seenCount = 0;
    const recentTypes: string[] = [];

    // Scan delivered batches in order. Predicate work is chained instead of run
    // inline so an async predicate never blocks stream delivery, and a later
    // batch can never overtake an earlier one. The first match wins; a predicate
    // that throws rejects the wait.
    let scan: Promise<void> = Promise.resolve();
    const handle = this.subscribe({
      eventTypes: args.eventTypes,
      replayAfterOffset: args.afterOffset,
      subscriber: { description: "waitForEvent" },
      processEventBatch: ({ events }) => {
        scan = scan.then(async () => {
          for (const event of events) {
            seenCount += 1;
            recentTypes.push(event.type);
            if (recentTypes.length > 20) recentTypes.shift();
            if (await predicate(event)) found.resolve(event);
          }
        });
        void scan.catch((error: unknown) => found.reject(error));
      },
    });

    const timer = setTimeout(() => {
      found.reject(
        new Error(
          `Timed out waiting for stream event after ${args.timeoutMs}ms ` +
            `(saw ${seenCount} events; recent types: ${recentTypes.join(", ") || "none"}).`,
        ),
      );
    }, args.timeoutMs);

    try {
      return await found.promise;
    } finally {
      clearTimeout(timer);
      handle.unsubscribe();
    }
  }

  /**
   * Subscribes to catch-up then live event batches.
   *
   * This method is synchronous because it mutates the in-memory connection
   * table and returns the live handle for the current Durable Object
   * incarnation. Cross-RPC callers still observe an async call through their
   * stub; do not make this DO method async unless the connection lifecycle is
   * redesigned.
   *
   * `subscribe({ subscriptionKey: "s", processEventBatch })` live-tails by default. Passing
   * `replayAfterOffset: 0` replays from the first event before live delivery; passing
   * `replayAfterOffset: 3` starts at offset 4. Re-subscribing with the same key replaces
   * the old connection. Omit `subscriptionKey` for an anonymous subscription; the stream
   * assigns a random key and returns it. Call the returned `unsubscribe()` to stop
   * delivery.
   *
   * Every batch carries the stream's core reduced `state` as of
   * `streamMaxOffset`, and every subscription — with or without replay —
   * immediately receives one batch on open so the subscriber can paint its
   * first render without a separate getState call: the replay batch when there
   * is one, otherwise a batch with `events: []`.
   *
   * Pass `events: false` for a state-only subscription: same batches, but
   * `events` is always `[]` and consecutive appends coalesce into one state
   * delivery. Replay is meaningless without events, so state-only
   * subscriptions are implicitly live-from-now (`replayAfterOffset` ignored).
   */
  subscribe(args: Parameters<Stream["subscribe"]>[0]): StreamSubscriptionHandle {
    const subscriptionKey = args.subscriptionKey?.trim() || crypto.randomUUID();
    if (this.#coreProcessorState.configuredSubscribersByKey[subscriptionKey] !== undefined) {
      throw new Error(
        `subscriptionKey "${subscriptionKey}" is reserved for a configured subscriber`,
      );
    }
    return this.#startSubscription({
      ...args,
      processEventBatch: args.processEventBatch,
      subscriber: args.subscriber as LiveStreamSubscriberDescriptor | undefined,
      subscriptionKey,
      subscriptionType: "ephemeral",
    });
  }

  subscribeConfigured(args: ConfiguredSubscribeArgs): StreamSubscriptionHandle {
    const subscriptionKey = args.subscriptionKey.trim();
    if (subscriptionKey.length === 0) throw new Error("subscriptionKey must not be blank.");
    if (this.#coreProcessorState.configuredSubscribersByKey[subscriptionKey] === undefined) {
      throw new Error(`configured subscriber "${subscriptionKey}" is not configured`);
    }
    return this.#startSubscription({
      ...args,
      processEventBatch: args.processEventBatch,
      subscriber: args.subscriber as LiveStreamSubscriberDescriptor | undefined,
      subscriptionKey,
      subscriptionType: "configured",
    });
  }

  getProcessorRuntimeState(args: { subscriptionKey: string }) {
    return this.#getProcessorRuntimeState(args);
  }

  runtimeState(): StreamDurableObjectRuntimeState {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.#connectionsRuntimeState(),
      },
    };
  }

  #idleTeardownMs(): number {
    const raw = (this.env as { STREAM_IDLE_TEARDOWN_MS?: string | number }).STREAM_IDLE_TEARDOWN_MS;
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STREAM_IDLE_TEARDOWN_MS;
  }

  // Keep the in-memory idle timer armed only while the DO holds configured
  // delivery connections (the thing that pins it resident). Reset on every
  // append; cleared once no configured connection remains. No storage writes, and
  // nothing scheduled against a hibernated DO.
  #armOrClearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (!this.#hasLiveConfiguredConnections()) return;
    this.#idleTimer = setTimeout(() => this.runIdleTeardownNow(), this.#idleTeardownMs());
  }

  /**
   * Sever every idle configured connection now — the idle timer's action, also
   * exposed directly for tests / operator "put this quiet stream to sleep".
   * Disposes the retained callback stubs so the freed subscriber DOs hibernate;
   * the durable subscription config is kept, so the next append re-wakes
   * (`needsConfiguredReconcile` in `append`).
   */
  runIdleTeardownNow(): void {
    this.#idleTimer = undefined;
    this.#closeIdleConfiguredConnections();
  }

  /**
   * Wipes this stream's durable storage and aborts the current incarnation.
   * The next request boots a fresh stream (new `created` + `woken` events).
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    this.kill();
  }

  /** Kills the current Durable Object incarnation so experiments can observe restart behavior. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  async wakeConfiguredSubscriber(args: {
    configured: CoreProcessorState["configuredSubscribersByKey"][string];
    subscriptionKey: string;
  }) {
    const { maxOffset, path, projectId } = this.#coreProcessorState;
    if (projectId === undefined || path === undefined) {
      throw new Error(
        "Cannot wake configured subscriber before stream coordinates are initialized.",
      );
    }
    await this.#wakeConfiguredSubscriberTarget({
      subscriber: args.configured.latestConfiguredEvent.payload.subscriber,
      request: {
        stream: {
          projectId,
          path,
          streamMaxOffset: maxOffset,
        },
        subscriptionKey: args.subscriptionKey,
      },
    });
  }

  async #wakeConfiguredSubscriberTarget(args: {
    request: StreamSubscriberWakeRequest;
    subscriber: ConfiguredStreamSubscriber;
  }): Promise<void> {
    const subscriber = args.subscriber;
    // This is a belt-and-braces check. Normal writes are rejected in
    // `#validateCoreAppend(...)`, before they become durable state. Keeping the
    // same validation on the wake path protects older/broken persisted state and
    // any future internal caller that reaches this method without going through
    // append first.
    this.#validateConfiguredSubscriberTarget(subscriber);
    if (subscriber.type === "worker") {
      await this.#wakeWorkerSubscriber(subscriber.workerRef, args.request);
      return;
    }

    const durableObjectName = DurableObjectNameCodec.stringify(subscriber.address, {
      allowNullProjectId: true,
    });
    await this.#configuredSubscriberDurableObject(
      subscriber.type,
      durableObjectName,
    ).wakeStreamSubscriber(args.request);
  }

  #configuredSubscriberDurableObject(
    type: ConfiguredSubscriberDurableObjectType,
    durableObjectName: string,
  ): ConfiguredSubscriberTarget {
    const namespace = {
      agent: this.env.AGENT,
      itx: this.env.ITX,
      project: this.env.PROJECT,
      repo: this.env.REPO,
      secret: this.env.SECRET,
    }[type];
    return namespace.getByName(durableObjectName) as unknown as ConfiguredSubscriberTarget;
  }

  async #wakeWorkerSubscriber(
    workerRef: DynamicWorkerRef,
    request: StreamSubscriberWakeRequest,
  ): Promise<void> {
    if (this.name.projectId === null) {
      throw new Error("configured worker subscribers require a project-scoped stream");
    }
    const itxScope = itxEntrypointProps({
      path: workerRef.path,
      projectId: this.name.projectId,
    });
    await new DynamicWorkerRunner({
      bindings: {
        ITX: this.ctx.exports.ItxEntrypoint({ props: itxScope }),
      },
      globalOutbound: projectEgressFetcher(this.ctx.exports, this.name.projectId),
      loader: this.env.LOADER,
      projectId: this.name.projectId,
      workerScopeKey: itxEntrypointScopeCacheKey(itxScope),
    }).invokeCapability({
      args: [request],
      path: ["wakeStreamSubscriber"],
      ref: workerRef,
    });
  }

  #validateConfiguredSubscriberTarget(subscriber: ConfiguredStreamSubscriber): void {
    if (subscriber.type === "worker") {
      // Worker subscribers do not carry a Durable Object address in the event.
      // Instead, the wake path builds an ITX/project scope from this stream's
      // own projectId and then invokes the DynamicWorkerRef inside that scope. That is
      // why workers are safe for project streams without a separate target
      // projectId field, and why global streams must reject them: there is no
      // project boundary to supply to the DynamicWorkerRunner. The test named
      // "global streams reject configured worker subscribers" covers this
      // before-commit behavior.
      if (this.name.projectId === null) {
        throw new Error("configured worker subscribers require a project-scoped stream");
      }
      return;
    }
    // Durable Object subscribers do carry an address in the event. The address
    // projectId has to equal the stream's projectId exactly; a global stream
    // (`projectId: null`) may only target a global address, and a project stream
    // may only target Durable Objects in that same project. This is the concrete
    // form of the configured-subscriber safety invariant: durable wakeup state
    // must never encode cross-project authority.
    this.#assertSameProject(subscriber.address.projectId, subscriber.type);
  }

  #validateStreamRuleTarget(rule: { projectId?: string | null }): void {
    if (
      rule.projectId === undefined ||
      rule.projectId === this.name.projectId ||
      rule.projectId === null
    ) {
      return;
    }

    throw new Error(
      `cross-post rule target projectId ${rule.projectId} does not match stream projectId ${this.name.projectId ?? "null"}`,
    );
  }

  #assertSameProject(projectId: string | null, subscriberType: ConfiguredStreamSubscriber["type"]) {
    if (projectId !== this.name.projectId) {
      throw new Error(
        `configured ${subscriberType} subscriber projectId ${projectId ?? "null"} does not match stream projectId ${this.name.projectId ?? "null"}`,
      );
    }
    if (projectId === null && subscriberType !== "repo") {
      throw new Error(`configured ${subscriberType} subscribers must be project-scoped`);
    }
  }
}

type ConfiguredSubscriberTarget = {
  wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<void>;
};

type ConfiguredSubscribeArgs = Parameters<Stream["subscribe"]>[0] & {
  subscriptionKey: string;
};

/**
 * A live delivery connection from this stream to one subscriber callback. Not
 * persisted; the callback and pump state live in the subscription closure, so
 * this is just metrics counters plus two control verbs.
 */
type Connection = {
  readonly subscriptionType: StreamSubscriptionType;
  readonly startedAt: string;
  /** Highest offset delivered to the callback; also the pump's resume cursor. */
  readonly cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
  getProcessorRuntimeState?: (() => ProcessorRuntimeState | Promise<ProcessorRuntimeState>) &
    Disposable;
  /** Re-arm the delivery pump after events are committed. Idempotent while draining. */
  wake(): void;
  /** Stop the pump, dispose the callback, append the disconnect fact, drop from the map. */
  close(reason: StreamSubscriberDisconnectReason): void;
};

/**
 * Projects a caller-supplied subscriber descriptor down to its serializable,
 * persisted form and validates it in one step. Parsing against the descriptor
 * schema strips the live, non-serializable `getRuntimeState` capability (it is
 * retained separately for the connection lifetime) and rejects a malformed
 * descriptor at the subscribe boundary, so a bad descriptor can never reach the
 * reducer and leave a live connection missing from the presence roster.
 */
function serializableSubscriber(subscriber: unknown): StreamSubscriberDescriptor {
  return StreamSubscriberDescriptorSchema.parse(subscriber);
}

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name) {
    throw new Error("Stream Durable Object must be addressed by name.");
  }
  return DurableObjectNameCodec.parse(name, { allowNullProjectId: true });
}

function* chunkBytes(value: Uint8Array, chunkSize: number): Generator<[number, ArrayBuffer]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer.");
  }
  let chunkIndex = 0;
  for (let start = 0; start < value.byteLength; start += chunkSize) {
    const end = Math.min(start + chunkSize, value.byteLength);
    const chunk = new ArrayBuffer(end - start);
    new Uint8Array(chunk).set(value.subarray(start, end));
    yield [chunkIndex, chunk];
    chunkIndex += 1;
  }
  if (chunkIndex === 0) yield [0, new ArrayBuffer(0)];
}

function decodeChunks(chunks: ArrayBuffer[]): string {
  const textDecoder = new TextDecoder();
  let value = "";
  for (const chunk of chunks) value += textDecoder.decode(chunk, { stream: true });
  return value + textDecoder.decode();
}
