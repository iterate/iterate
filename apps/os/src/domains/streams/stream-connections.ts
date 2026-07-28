import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamEvent,
  StreamEventBatch,
  StreamEventInput,
  StreamConnectionPing,
  StreamWakeDeliveryError,
  StreamWakeDeliveryResult,
  StreamWakeEventBatch,
} from "iterate/processors";
import { LatencyRing, pingRoundTrip, type LatencyStats } from "iterate/processors";
import type {
  CoreProcessorState,
  ConnectionOpenerDescriptor,
  ConnectionCloseReason,
  StreamConnectionKind,
} from "./core-processor-contract.ts";
import { EventFilterEvaluationError, type CompiledEventFilter } from "./event-filter.ts";
import {
  boundedErrorMessage,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  withDeliveryTimeout,
} from "./stream-delivery-utils.ts";
import { isDurableObjectLifecycleError } from "./stream-unavailable.ts";
import type { SizedStreamEvent, SubscriptionCursorStore } from "./stream-storage.ts";
import {
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
  retainConnectionPing,
  type RetainedProcessEventBatch,
  type RetainedConnectionPing,
} from "./retained-event-callbacks.ts";
import { DELIVERY_BATCH_LIMIT } from "./delivery-math.ts";

/** Configuration and deliveredThroughOffset values captured before an asynchronous delivery starts. */
export type ExpectedDeliveryState = {
  configuredAtOffset: number;
  cursorChangedAtOffset: number;
};

/** Also distinguishes replacement callbacks opened within one durable generation. */
export type ExpectedHostedDeliveryState = ExpectedDeliveryState & {
  connectionGeneration: number;
};

/** Delivery progress and retry details shared by every live callback connection. */
type ConnectionRuntimeDetails = {
  startedAt: string;
  deliveredThroughOffset: number;
  lag: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastDeliveredAt?: string;
  completionLatencyMs?: LatencyStats;
  pingRttMs?: LatencyStats;
  openedBy?: ConnectionOpenerDescriptor;
  hasPendingDelivery: boolean;
  pendingDeliveryStartedAt?: string;
  pendingDeliveryDeadlineAt?: string;
};

/** Serializable debug view of one live callback connection. */
export type ConnectionRuntimeState = ConnectionRuntimeDetails &
  (
    | { kind: "session" }
    | {
        kind: "hosted";
        /** The durable subscription whose processor callback this connection serves. */
        subscriptionKey: string;
      }
  );

/** One live event-batch callback. Copy, ITX-call, and webhook subscriptions do not appear here. */
export type StreamConnection = {
  readonly kind: StreamConnectionKind;
  readonly expectedHostedDelivery?: ExpectedHostedDeliveryState;
  readonly startedAt: string;
  readonly openedBy?: ConnectionOpenerDescriptor;
  readonly deliveredThroughOffset: number;
  batchesSent: number;
  eventsSent: number;
  bytesSent: number;
  lastDeliveredAt?: string;
  readonly completionLatency: LatencyRing;
  readonly pingRtt: LatencyRing;
  ping?: RetainedConnectionPing;
  getProcessorRuntimeState?: GetProcessorRuntimeState & Disposable;
  sendQueued(): void;
  isLive(): boolean;
  hasPendingDelivery(): boolean;
  pendingDeliveryStartedAtMs(): number | null;
  pendingDeliveryDeadlineAtMs(): number | null;
  close(reason: ConnectionCloseReason, error?: string): void;
};

type OpenConnectionArgs<Batch extends StreamEventBatch> = {
  connectionKey: string;
  kind: StreamConnectionKind;
  expectedHostedDelivery?: ExpectedHostedDeliveryState;
  processEventBatch: RetainedProcessEventBatch<Batch>;
  replayAfterOffset?: number;
  expectedStreamId?: string | null;
  maxReplayOffsetGap?: number;
  filter?: CompiledEventFilter;
  events?: boolean;
  openedBy?: ConnectionOpenerDescriptor;
  getRuntimeState?: GetProcessorRuntimeState;
  ping?: StreamConnectionPing;
  sendOnOpen?: boolean;
};

type StreamConnectionsHooks = {
  readBatch(afterOffset: number, beforeOffset: number, limit: number): SizedStreamEvent[];
  coreState(): CoreProcessorState;
  store: SubscriptionCursorStore;
  appendDeliveryEvent(event: StreamEventInput): boolean;
  recordEgress(count: number, bytes: number): void;
  runtimeChanged(): void;
  now(): number;
  armAlarm(atMs: number): void;
  keepAlive(promise: Promise<unknown>): void;
  hostedDeliveryStillMatches(
    connectionKey: string,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): boolean;
  onHostedDeliveryFailure(connectionKey: string, error: unknown): void;
  sendDueSubscriptions(): void;
};

const PING_ROUND_MIN_INTERVAL_MS = 5_000;
const PING_TIMEOUT_MS = 10_000;
function connectionError(error: unknown): string {
  return boundedErrorMessage(error) ?? "unknown error";
}

/**
 * Runtime state machine for session callbacks and hosted-processor callbacks.
 *
 * It owns only live capabilities, callback send loops, connection generations, metrics, and
 * idle teardown. Stored durable configuration, cursors, failing-event policy, and receiver
 * retries stay in StreamEventSender. The hooks are the explicit boundary
 * between those independent responsibilities.
 */
export class StreamConnections {
  readonly #hooks: StreamConnectionsHooks;
  readonly #idleTeardownMs: number;
  readonly #connections = new Map<string, StreamConnection>();
  #idleTeardownAtMs: number | null = null;
  #tearingDown = false;
  #lastPingRoundAtMs: number | null = null;

  constructor(args: { idleTeardownMs: number; hooks: StreamConnectionsHooks }) {
    this.#idleTeardownMs = args.idleTeardownMs;
    this.#hooks = args.hooks;
  }

  get isTearingDown(): boolean {
    return this.#tearingDown;
  }

  sendQueued(): void {
    for (const connection of this.#connections.values()) connection.sendQueued();
  }

  /**
   * Close hosted callbacks whose configuration/cursor generation is no
   * longer current before they can receive another batch. This is the
   * level-triggered backstop for a configuration/removal hook interrupted
   * after its event committed.
   */
  closeStaleHosted(
    reasonFor: (
      connectionKey: string,
    ) => Extract<ConnectionCloseReason, "replaced" | "subscription-removed">,
  ): void {
    for (const [connectionKey, connection] of this.#connections) {
      if (
        connection.kind !== "hosted" ||
        connection.expectedHostedDelivery === undefined ||
        this.#hooks.hostedDeliveryStillMatches(connectionKey, connection.expectedHostedDelivery)
      ) {
        continue;
      }
      connection.close(reasonFor(connectionKey));
    }
  }

  onAlarm(): string[] {
    const now = this.#hooks.now();
    for (const [connectionKey, connection] of this.#connections) {
      const deadlineAt = connection.pendingDeliveryDeadlineAtMs();
      if (
        deadlineAt === null ||
        deadlineAt > now ||
        connection.expectedHostedDelivery === undefined
      ) {
        continue;
      }
      this.onHostedDeliveryError(
        connectionKey,
        new Error(
          `hosted processor batch acknowledgement timed out after ${DEFAULT_DELIVERY_TIMEOUT_MS}ms`,
        ),
        connection.expectedHostedDelivery,
      );
    }
    if (this.#idleTeardownAtMs !== null && this.#idleTeardownAtMs <= this.#hooks.now()) {
      return this.runIdleTeardownNow();
    }
    return [];
  }

  rearmIdleAlarm(): void {
    if (this.#idleTeardownAtMs !== null) this.#hooks.armAlarm(this.#idleTeardownAtMs);
  }

  openSession(args: {
    connectionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    expectedStreamId?: string | null;
    maxReplayOffsetGap?: number;
    filter?: CompiledEventFilter;
    events?: boolean;
    openedBy?: ConnectionOpenerDescriptor;
    getRuntimeState?: GetProcessorRuntimeState;
    ping?: StreamConnectionPing;
  }): StreamConnection {
    return this.#open({
      ...args,
      kind: "session",
      // Ephemeral results remain deliberately unpulled; openedBy liveness
      // is session-owned through close/onRpcBroken.
      processEventBatch: retainProcessEventBatch(args.processEventBatch),
    });
  }

  openHosted(args: Omit<OpenConnectionArgs<StreamWakeEventBatch>, "kind">): StreamConnection {
    return this.#open({ ...args, kind: "hosted", sendOnOpen: false });
  }

  replace(connectionKey: string): void {
    this.#connections.get(connectionKey)?.close("replaced");
  }

  remove(connectionKey: string): void {
    this.#connections.get(connectionKey)?.close("subscription-removed");
  }

  close(connectionKey: string, reason: ConnectionCloseReason): void {
    this.#connections.get(connectionKey)?.close(reason);
  }

  has(connectionKey: string): boolean {
    return this.#connections.has(connectionKey);
  }

  connectionKind(connectionKey: string): StreamConnection["kind"] | undefined {
    return this.#connections.get(connectionKey)?.kind;
  }

  async getProcessorRuntimeState(connectionKey: string): Promise<ProcessorRuntimeState | null> {
    const connection = this.#connections.get(connectionKey);
    return (await connection?.getProcessorRuntimeState?.()) ?? null;
  }

  /** Back off a failing hosted callback before closing and activating it again. */
  onHostedDeliveryError(
    connectionKey: string,
    error: unknown,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): void {
    const connection = this.#connections.get(connectionKey);
    if (
      connection === undefined ||
      connection.expectedHostedDelivery?.connectionGeneration !==
        expectedDelivery.connectionGeneration ||
      !this.#hooks.hostedDeliveryStillMatches(connectionKey, expectedDelivery)
    ) {
      return;
    }
    const details = { connectionKey, error };
    if (error instanceof EventFilterEvaluationError) {
      console.info("stream hosted callback filter condition failed; backing off", details);
    } else if (isDurableObjectLifecycleError(error)) {
      console.warn(
        "stream durable callback unavailable; backing off before waking it again",
        details,
      );
    } else {
      console.error("stream durable callback failed; backing off before waking it again", details);
    }
    this.#hooks.onHostedDeliveryFailure(connectionKey, error);
    connection.close("delivery-failed", connectionError(error));
  }

  samplePingsSoon(): void {
    const now = this.#hooks.now();
    if (
      this.#lastPingRoundAtMs !== null &&
      now - this.#lastPingRoundAtMs < PING_ROUND_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.#lastPingRoundAtMs = now;
    for (const connection of this.#connections.values()) {
      const ping = connection.ping;
      if (ping === undefined) continue;
      const t0 = this.#hooks.now();
      const work = (async () => {
        try {
          const reply = await withDeliveryTimeout(Promise.resolve(ping({ t0 })), "ping", {
            timeoutMs: PING_TIMEOUT_MS,
          });
          const t3 = this.#hooks.now();
          if (
            typeof reply?.t1 !== "number" ||
            typeof reply.t2 !== "number" ||
            !Number.isFinite(reply.t1) ||
            !Number.isFinite(reply.t2)
          ) {
            return;
          }
          const { rttMs } = pingRoundTrip({ t0, t1: reply.t1, t2: reply.t2 }, t3);
          if (connection.isLive()) {
            connection.pingRtt.record(rttMs, t3);
            this.#hooks.runtimeChanged();
          }
        } catch {
          // Ping sampling is observational; delivery owns liveness.
        }
      })();
      this.#hooks.keepAlive(work);
    }
  }

  runtimeState(): Record<string, ConnectionRuntimeState> {
    const maxOffset = this.#hooks.coreState().maxOffset;
    return Object.fromEntries(
      [...this.#connections].map(([connectionKey, connection]) => {
        const completionLatencyMs = connection.completionLatency.stats();
        const pingRttMs = connection.pingRtt.stats();
        const pendingDeliveryStartedAtMs = connection.pendingDeliveryStartedAtMs();
        const pendingDeliveryDeadlineAtMs = connection.pendingDeliveryDeadlineAtMs();
        return [
          connectionKey,
          {
            ...(connection.kind === "hosted"
              ? { kind: "hosted" as const, subscriptionKey: connectionKey }
              : { kind: "session" as const }),
            startedAt: connection.startedAt,
            deliveredThroughOffset: connection.deliveredThroughOffset,
            lag: Math.max(0, maxOffset - connection.deliveredThroughOffset),
            batchesSent: connection.batchesSent,
            eventsSent: connection.eventsSent,
            bytesSent: connection.bytesSent,
            lastDeliveredAt: connection.lastDeliveredAt,
            hasPendingDelivery: connection.hasPendingDelivery(),
            ...(pendingDeliveryDeadlineAtMs === null
              ? {}
              : {
                  pendingDeliveryDeadlineAt: new Date(pendingDeliveryDeadlineAtMs).toISOString(),
                  ...(pendingDeliveryStartedAtMs === null
                    ? {}
                    : {
                        pendingDeliveryStartedAt: new Date(
                          pendingDeliveryStartedAtMs,
                        ).toISOString(),
                      }),
                }),
            ...(completionLatencyMs === null ? {} : { completionLatencyMs }),
            ...(pingRttMs === null ? {} : { pingRttMs }),
            ...(connection.openedBy === undefined ? {} : { openedBy: connection.openedBy }),
          },
        ];
      }),
    );
  }

  armOrClearIdleAlarm(): void {
    if (this.#hostedConnectionKeys().length === 0) {
      this.#idleTeardownAtMs = null;
      return;
    }
    this.#idleTeardownAtMs = this.#hooks.now() + this.#idleTeardownMs;
    this.#hooks.armAlarm(this.#idleTeardownAtMs);
  }

  runIdleTeardownNow(): string[] {
    this.#idleTeardownAtMs = null;
    const keys = this.#hostedConnectionKeys();
    const wedgedKeys = new Set(
      keys.filter((key) => this.#connections.get(key)?.hasPendingDelivery() === true),
    );
    this.#tearingDown = true;
    try {
      for (const connectionKey of keys) this.close(connectionKey, "idle");
    } finally {
      this.#tearingDown = false;
    }
    // Closing each callback appends its connection-closed fact synchronously.
    // A settled hosted processor has already handled everything that existed
    // before teardown, and waking it solely to consume those close facts would
    // create an immediate close -> wake -> open -> idle-close loop. Advance its
    // cursor through the close facts on purpose. A processor that consumes
    // connection presence sees them on its next real wake, when the runner
    // replays from its own reported checkpoint; the sending cursor is only the
    // source stream's wake/delivery position.
    const maxOffset = this.#hooks.coreState().maxOffset;
    for (const connectionKey of keys) {
      if (wedgedKeys.has(connectionKey)) continue;
      this.#hooks.store.ack(connectionKey, maxOffset);
    }
    this.#idleTeardownAtMs = null;
    if (wedgedKeys.size > 0) queueMicrotask(() => this.#hooks.sendDueSubscriptions());
    return keys.filter((connectionKey) => !wedgedKeys.has(connectionKey));
  }

  #hostedConnectionKeys(): string[] {
    return [...this.#connections]
      .filter(([, connection]) => connection.kind === "hosted")
      .map(([connectionKey]) => connectionKey);
  }

  #open<Batch extends StreamEventBatch>(args: OpenConnectionArgs<Batch>): StreamConnection {
    const { connectionKey, kind, processEventBatch } = args;
    const deliverEvents = args.events !== false;
    const coreState = this.#hooks.coreState();
    const openedAtOffset = coreState.maxOffset;
    if (kind === "hosted" && args.expectedHostedDelivery === undefined) {
      processEventBatch[Symbol.dispose]();
      throw new Error("hosted processor connections require the expected delivery state");
    }
    if (
      args.replayAfterOffset !== undefined &&
      (!Number.isSafeInteger(args.replayAfterOffset) || args.replayAfterOffset < 0)
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("replayAfterOffset must be a non-negative safe integer");
    }
    if (
      args.expectedStreamId !== undefined &&
      args.expectedStreamId !== null &&
      args.expectedStreamId.trim().length === 0
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("expectedStreamId must be null or a non-empty string");
    }
    if (
      args.expectedStreamId !== undefined &&
      (coreState.streamId ?? null) !== args.expectedStreamId
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `stream ID changed (${String(args.expectedStreamId)} -> ${String(coreState.streamId ?? null)})`,
      );
    }
    if (
      args.maxReplayOffsetGap !== undefined &&
      (!Number.isSafeInteger(args.maxReplayOffsetGap) || args.maxReplayOffsetGap < 0)
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error("maxReplayOffsetGap must be a non-negative safe integer");
    }
    let deliveredThroughOffset = deliverEvents
      ? (args.replayAfterOffset ?? openedAtOffset)
      : openedAtOffset;
    if (deliveredThroughOffset > openedAtOffset) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `replayAfterOffset ${deliveredThroughOffset} is greater than the stream maximum offset ${openedAtOffset}`,
      );
    }
    if (
      deliverEvents &&
      args.maxReplayOffsetGap !== undefined &&
      openedAtOffset - deliveredThroughOffset > args.maxReplayOffsetGap
    ) {
      processEventBatch[Symbol.dispose]();
      throw new Error(
        `replay gap ${openedAtOffset - deliveredThroughOffset} exceeds maxReplayOffsetGap ${args.maxReplayOffsetGap}`,
      );
    }

    this.#connections.get(connectionKey)?.close("replaced");
    try {
      const openedRecorded = this.#hooks.appendDeliveryEvent({
        type: "events.iterate.com/stream/connection-opened",
        payload: {
          connectionKey,
          kind,
          ...(args.openedBy === undefined ? {} : { openedBy: args.openedBy }),
        },
      });
      if (!openedRecorded) {
        throw Object.assign(
          new Error(
            `connection "${connectionKey}" opened-event append was interrupted by Durable Object lifecycle teardown`,
          ),
          { retryable: true },
        );
      }
    } catch (error) {
      // The callback crossed an RPC boundary before this method started, so
      // this method owns it even when the durable opened fact cannot commit.
      processEventBatch[Symbol.dispose]();
      throw error;
    }

    let initialBatchPending = true;
    let sendLoopRunning = false;
    let open = true;
    let hostedBatchPending = false;
    let hostedBatchToken: symbol | null = null;
    let hostedBatchStartedAtMs: number | null = null;
    let hostedBatchDeadlineAtMs: number | null = null;
    let connection!: StreamConnection;

    const sendQueuedBatches = async () => {
      if (sendLoopRunning || (kind === "hosted" && hostedBatchPending)) return;
      sendLoopRunning = true;
      try {
        while (open) {
          let events: StreamEvent[] = [];
          let deliveredBytes = 0;
          const scannedAfterOffset = deliveredThroughOffset;
          if (deliverEvents) {
            const readEvents = this.#hooks.readBatch(
              deliveredThroughOffset,
              Number.MAX_SAFE_INTEGER,
              DELIVERY_BATCH_LIMIT,
            );
            const lastOffset = readEvents.at(-1)?.event.offset;
            if (lastOffset === undefined) {
              const currentMaxOffset = this.#hooks.coreState().maxOffset;
              if (currentMaxOffset <= deliveredThroughOffset && !initialBatchPending) return;
              deliveredThroughOffset = Math.max(deliveredThroughOffset, currentMaxOffset);
            } else {
              deliveredThroughOffset = lastOffset;
              const visible =
                kind === "hosted"
                  ? readEvents.filter((entry) => entry.event.ephemeral !== true)
                  : readEvents.filter(
                      (entry) =>
                        entry.event.ephemeral !== true || entry.event.offset > openedAtOffset,
                    );
              const delivered =
                args.filter === undefined
                  ? visible
                  : visible.filter((entry) => args.filter!.matches(entry.event));
              events = delivered.map((entry) => entry.event);
              deliveredBytes = delivered.reduce((sum, entry) => sum + entry.byteLength, 0);
            }
          } else {
            const stateMaxOffset = this.#hooks.coreState().maxOffset;
            if (stateMaxOffset <= deliveredThroughOffset && !initialBatchPending) return;
            deliveredThroughOffset = stateMaxOffset;
          }
          initialBatchPending = false;
          connection.batchesSent += 1;
          connection.eventsSent += events.length;
          connection.bytesSent += deliveredBytes;
          connection.lastDeliveredAt = new Date(this.#hooks.now()).toISOString();
          this.#hooks.recordEgress(events.length, deliveredBytes);
          const currentState = this.#hooks.coreState();
          if (
            currentState.projectId === undefined ||
            currentState.path === undefined ||
            currentState.streamId === undefined
          ) {
            throw new Error("Cannot deliver stream batch before stream identity is initialized.");
          }
          const newestCreatedAtMs =
            events.length === 0 ? undefined : Date.parse(events.at(-1)!.createdAt);
          const batch = {
            projectId: currentState.projectId,
            path: currentState.path,
            streamId: currentState.streamId,
            events,
            scannedAfterOffset,
            scannedThroughOffset: deliveredThroughOffset,
            streamMaxOffset: currentState.maxOffset,
            state: currentState,
          } satisfies StreamEventBatch;
          if (kind === "hosted") {
            const expectedDelivery = args.expectedHostedDelivery!;
            const deliveryToken = Symbol("hosted stream delivery");
            hostedBatchPending = true;
            hostedBatchToken = deliveryToken;
            hostedBatchStartedAtMs = this.#hooks.now();
            hostedBatchDeadlineAtMs = hostedBatchStartedAtMs + DEFAULT_DELIVERY_TIMEOUT_MS;
            // This SQLite write and the native alarm are both issued before
            // the callback leaves the source DO. The output gate therefore
            // makes a vanished isolate recover as an expired durable attempt,
            // not as an unbounded series of first-attempt wake calls.
            this.#hooks.store.markInFlight(connectionKey, {
              deadlineAt: hostedBatchDeadlineAtMs,
              connectionGeneration: expectedDelivery.connectionGeneration,
              cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
            });
            this.#hooks.armAlarm(hostedBatchDeadlineAtMs);
            (processEventBatch as unknown as RetainedProcessEventBatch<StreamWakeEventBatch>)({
              ...batch,
              reportDeliveryResult: (deliveryResult) => {
                // Each callback belongs to exactly one batch. Duplicate or
                // late reports cannot complete a replacement connection or the
                // next batch on this connection.
                if (hostedBatchToken !== deliveryToken) return;
                hostedBatchPending = false;
                hostedBatchToken = null;
                hostedBatchStartedAtMs = null;
                hostedBatchDeadlineAtMs = null;
                const parsed = parseWakeDeliveryResult(deliveryResult);
                if (
                  parsed.outcome === "ok" &&
                  connection.isLive() &&
                  this.#connections.get(connectionKey) === connection &&
                  this.#hooks.hostedDeliveryStillMatches(connectionKey, expectedDelivery)
                ) {
                  this.#hooks.store.clearInFlight(connectionKey, {
                    connectionGeneration: expectedDelivery.connectionGeneration,
                    cursorChangedAtOffset: expectedDelivery.cursorChangedAtOffset,
                  });
                  if (newestCreatedAtMs !== undefined && Number.isFinite(newestCreatedAtMs)) {
                    const completedAtMs = this.#hooks.now();
                    connection.completionLatency.record(
                      completedAtMs - newestCreatedAtMs,
                      completedAtMs,
                    );
                  }
                  // Run after this sendQueuedBatches's finally clears
                  // `sendLoopRunning`; this is the only path that dispatches
                  // the next hosted batch.
                  queueMicrotask(() => connection.sendQueued());
                } else if (
                  parsed.outcome === "error" &&
                  connection.isLive() &&
                  this.#connections.get(connectionKey) === connection
                ) {
                  this.onHostedDeliveryError(connectionKey, parsed.error, expectedDelivery);
                }
                this.#hooks.runtimeChanged();
              },
            } satisfies StreamWakeEventBatch);
          } else {
            (processEventBatch as RetainedProcessEventBatch<StreamEventBatch>)(batch);
          }
          this.#hooks.runtimeChanged();
          // Hosted processors acknowledge in order, one batch at a time. Do
          // not await the remote promise in this invocation tree; the result callback
          // or the native-alarm watchdog starts the next state transition.
          if (kind === "hosted") return;
          await Promise.resolve();
        }
      } catch (error) {
        if (kind === "hosted" && args.expectedHostedDelivery !== undefined) {
          this.onHostedDeliveryError(connectionKey, error, args.expectedHostedDelivery);
        } else {
          const details = { connectionKey, error };
          if (error instanceof EventFilterEvaluationError) {
            console.info("stream session filter condition failed; closing connection", details);
          } else {
            console.error("stream session callback failed; closing connection", details);
          }
          connection.close("delivery-failed", connectionError(error));
        }
      } finally {
        sendLoopRunning = false;
      }
    };

    connection = {
      kind,
      ...(args.expectedHostedDelivery === undefined
        ? {}
        : { expectedHostedDelivery: args.expectedHostedDelivery }),
      startedAt: new Date(this.#hooks.now()).toISOString(),
      ...(args.openedBy === undefined ? {} : { openedBy: args.openedBy }),
      getProcessorRuntimeState: retainGetProcessorRuntimeState(args.getRuntimeState),
      ping: retainConnectionPing(args.ping),
      get deliveredThroughOffset() {
        return deliveredThroughOffset;
      },
      batchesSent: 0,
      eventsSent: 0,
      bytesSent: 0,
      completionLatency: new LatencyRing(),
      pingRtt: new LatencyRing(),
      sendQueued: () => void sendQueuedBatches(),
      isLive: () => open,
      hasPendingDelivery: () => (kind === "hosted" ? hostedBatchPending : false),
      pendingDeliveryStartedAtMs: () => hostedBatchStartedAtMs,
      pendingDeliveryDeadlineAtMs: () => hostedBatchDeadlineAtMs,
      close: (reason, error) => {
        if (!open) return;
        open = false;
        hostedBatchPending = false;
        hostedBatchToken = null;
        hostedBatchStartedAtMs = null;
        hostedBatchDeadlineAtMs = null;
        if (this.#connections.get(connectionKey) === connection) {
          this.#connections.delete(connectionKey);
          this.#hooks.runtimeChanged();
        }
        connection.ping?.[Symbol.dispose]();
        processEventBatch[Symbol.dispose]();
        connection.getProcessorRuntimeState?.[Symbol.dispose]();
        // Best-effort by design. A lifecycle-interrupted append loses this
        // observation exactly as abrupt isolate death does: the in-memory
        // connection table is its only witness, so a fresh incarnation has
        // nothing durable from which to retry. Runtime state, not paired
        // opened/closed events, remains authoritative for "open now".
        void this.#hooks.appendDeliveryEvent({
          type: "events.iterate.com/stream/connection-closed",
          payload: { connectionKey, reason, ...(error === undefined ? {} : { error }) },
        });
        if (reason === "rpc-broken" || reason === "delivery-failed") {
          this.#hooks.sendDueSubscriptions();
        }
      },
    };

    // The opened fact was recorded before this object retained optional
    // capabilities or published the callback in the in-memory table.
    // Appending it ran the stream's post-commit send check synchronously;
    // publishing first would let a hosted callback receive a batch before the
    // wake path records the processor's reported checkpoint.
    this.#connections.set(connectionKey, connection);
    this.#hooks.runtimeChanged();
    processEventBatch.onRpcBroken?.((error) => {
      if (kind === "hosted" && args.expectedHostedDelivery !== undefined) {
        this.onHostedDeliveryError(connectionKey, error, args.expectedHostedDelivery);
      } else {
        connection.close("rpc-broken", connectionError(error));
      }
    });
    if (args.sendOnOpen !== false) connection.sendQueued();
    return connection;
  }
}

/** Turn the hosted processor's wire-safe result into the error shape used by retry policy. */
function parseWakeDeliveryResult(
  value: StreamWakeDeliveryResult,
): { outcome: "ok" } | { outcome: "error"; error: Error } {
  const candidate = value as Partial<StreamWakeDeliveryResult> | null;
  if (candidate?.outcome === "ok") return { outcome: "ok" };
  if (candidate?.outcome !== "error" || !("error" in candidate)) {
    return {
      outcome: "error",
      error: new Error("hosted processor reported an invalid delivery result"),
    };
  }
  const serialized = candidate.error as Partial<StreamWakeDeliveryError> | null;
  if (typeof serialized?.name !== "string" || typeof serialized.message !== "string") {
    return {
      outcome: "error",
      error: new Error("wake delivery reported an invalid failure"),
    };
  }
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return {
    outcome: "error",
    error: Object.assign(error, {
      ...(serialized.durableObjectReset === true ? { durableObjectReset: true } : {}),
      ...(serialized.overloaded === true ? { overloaded: true } : {}),
      ...(serialized.retryable === true ? { retryable: true } : {}),
    }),
  };
}
