import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type {
  ProcessorRuntimeState,
  StreamDeliveryBatch,
  StreamProcessorWakeRequest,
  StreamWebhookDelivery,
  CopyReceipt,
  StreamConnectionHandle,
} from "iterate/processors";
import {
  idempotencyConflictMessage,
  jsonValuesEqual,
  sameIdempotentEvent,
  StreamIdMismatchError,
  streamIdMismatchMessage,
  StreamReceiverUnavailableError,
} from "iterate/processors";
import { StreamOffsetConflictError, streamOffsetConflictMessage } from "iterate/processors";
import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { StreamEventInput as StreamEventInputSchema } from "iterate/processors";
import { StreamRuntimeMetrics } from "iterate/processors";
import { disposeIgnoredRpcResult, LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { streamDeliveryAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { evaluateItxExpression, type ItxExpression } from "../../itx/expression.ts";
import type { Stream } from "../../itx-api.generated.ts";
import {
  deploymentItxForInternal,
  itxForScope,
  StreamConnectionRpcTarget,
} from "../../rpc-targets.ts";
import { canonicalizeStreamPath, DurableObjectNameCodec } from "../durable-object-names.ts";
import { posthogSubscriptionEvent } from "../integrations/posthog.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { buildCopyAppends } from "./copy-appends.ts";
import {
  assertCoreProcessorCheckpointGrowthFits,
  STREAM_PAUSED_ERROR_PREFIX,
  StreamCoreProcessor,
} from "./core-processor.ts";
import { compileEventFilter, type EventFilter } from "./event-filter.ts";
import {
  STREAM_WAKE_SOCKET_HEADER,
  WAKE_EXCLUDED_EVENT_TYPES,
  WAKE_SOCKET_TAG,
  WakeSocketAttachment,
  WakeSocketUpgradeHeader,
} from "./wake-socket.ts";
import {
  internalStreamId,
  isInternalStreamIdempotencyKey,
  sameCopiedEventIdentity,
} from "./stream-delivery-utils.ts";
import {
  pruneOrphanedSubscriptionCursorRows,
  clearSubscriptionCursorFailuresAfterStateRebuild,
  SqliteSubscriptionCursorStore,
  StreamEventLog,
} from "./stream-storage.ts";
import {
  computeBackoffMs,
  StreamEventSender,
  type ExpectedHostedDeliveryState,
  type SubscriptionReceiverCalls,
} from "./stream-event-sender.ts";
import type { StreamRuntimeDebugState } from "./stream-runtime-state.ts";
import { retainProcessorWakeResponse } from "./retained-event-callbacks.ts";
import {
  isDurableObjectLifecycleError,
  STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX,
} from "./stream-unavailable.ts";
import {
  CORE_STATE_VERSION,
  CoreProcessorContract,
  ConnectionOpenerDescriptor as ConnectionOpenerDescriptorSchema,
  parseCommittedCoreEvent,
  subscriptionKeyForConfiguredEvent,
  type CommittedSubscriptionConfiguredEvent,
  type CommittedSubscriptionRemovedEvent,
  type CoreProcessorState,
  type SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";

const DEFAULT_GET_EVENTS_LIMIT = 500;
const MAX_GET_EVENTS_LIMIT = 500;
const CORE_STATE_REBUILD_KEY = "coreStateRebuild";
const CORE_STATE_REBUILD_CHECKPOINT_EVERY_PAGES = 8;

const CoreStateRebuildCheckpoint = z.strictObject({
  stateVersion: z.literal(CORE_STATE_VERSION),
  state: CoreProcessorContract.stateSchema,
});

function isStreamPausedError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    error.message.startsWith(STREAM_PAUSED_ERROR_PREFIX)
  );
}

/**
 * Observe fire-and-forget stream-core work without handing a rejected promise
 * to `waitUntil`. A deployment replaces the current Durable Object
 * incarnation and rejects its in-flight stub calls; that is a lifecycle
 * interruption, while an application rejection remains an error.
 */
export async function settleStreamCoreBackgroundWork(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isStreamPausedError(error)) {
      console.info("stream core background work reached a paused stream", {
        message: error.message,
      });
      return;
    }
    if (isDurableObjectLifecycleError(error)) {
      console.info("stream core background work interrupted by durable object lifecycle", {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    console.error("stream core background work failed", error);
  }
}

/**
 * Starts durable sends outside the append request's current promise chain.
 *
 * A Stream append can itself run inside a hosted processor callback. If its
 * post-commit delivery is attached to that append with `ctx.waitUntil`, a
 * delivery back to the caller closes a cycle: caller waits for append, append
 * waits for delivery, and delivery waits for caller. Outside an alarm turn we
 * therefore retain only the short `setAlarm(now)` operation. The alarm starts
 * a fresh invocation, re-derives owed work from durable cursors, and may then
 * retain the delivery attempt without holding any append caller open.
 *
 * The work closure is deliberately NOT remembered between turns. Its durable
 * representation is subscription cursor lag; `onAlarm()` reads that lag
 * and supplies a fresh closure even after isolate eviction.
 */
type StreamDeliveryAlarmBoundaryHooks = {
  armAlarm(atMs: number): void;
  now(): number;
  waitUntil(work: Promise<unknown>): void;
};

type StreamAlarmStorage = {
  setAlarm(atMs: number): Promise<void>;
};

/**
 * Issues the native alarm write in the same synchronous storage turn as the
 * cursor/event write that made delivery necessary. Durable Object output
 * gates make that load-bearing: a failed setAlarm resets the object and
 * suppresses its outgoing response, so cursor lag cannot commit as an
 * acknowledged success without its wakeup.
 *
 * Do not add a getAlarm/await before setAlarm. Multiple writes made without
 * an intervening await coalesce into one implicit transaction. A fresh Stream
 * incarnation appends `woken`, so its first useful arm is immediate and may
 * safely replace an inherited later alarm.
 *
 * https://developers.cloudflare.com/durable-objects/reference/glossary/#output-gate
 * https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work
 */
export class StreamAlarmArmer {
  readonly #storage: StreamAlarmStorage;
  #armedForMs: number | null = null;

  constructor(storage: StreamAlarmStorage) {
    this.#storage = storage;
  }

  armNoLaterThan(atMs: number): void {
    const previous = this.#armedForMs;
    if (previous !== null && previous <= atMs) return;
    this.#armedForMs = atMs;
    try {
      // Deliberately not awaited or caught: the native output gate owns the
      // write and turns an asynchronous failure into an invocation failure.
      void this.#storage.setAlarm(atMs);
    } catch (cause) {
      this.#armedForMs = previous;
      throw new Error("stream alarm arming failed", { cause });
    }
  }

  markFired(): void {
    this.#armedForMs = null;
  }
}

export class StreamDeliveryAlarmBoundary {
  readonly #hooks: StreamDeliveryAlarmBoundaryHooks;
  #inAlarmTurn = false;

  constructor(hooks: StreamDeliveryAlarmBoundaryHooks) {
    this.#hooks = hooks;
  }

  scheduleOrRun(work: () => Promise<unknown>): void {
    if (this.#inAlarmTurn) {
      this.#hooks.waitUntil(settleStreamCoreBackgroundWork(work));
      return;
    }
    // setAlarm is itself an output-gated storage write. Issue it directly in
    // this append turn: wrapping it in a settling waitUntil would cross the
    // implicit-transaction boundary and could acknowledge lag without a wake.
    this.#hooks.armAlarm(this.#hooks.now());
  }

  runAlarmTurn(work: () => void): void {
    const wasInAlarmTurn = this.#inAlarmTurn;
    this.#inAlarmTurn = true;
    try {
      work();
    } finally {
      this.#inAlarmTurn = wasInAlarmTurn;
    }
  }
}

// The concrete calls a source stream can make to subscription receivers.
// Callback retention is separate in retained-event-callbacks.ts.

const WORKERS_HUNG_ENTRYPOINT_MESSAGE =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

function isWorkersHungEntrypointError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    error.message.startsWith(WORKERS_HUNG_ENTRYPOINT_MESSAGE)
  );
}

/** Convert a canceled project-worker call into the receiver-availability error contract. */
function rethrowItxDeliveryError(error: unknown): never {
  if (isWorkersHungEntrypointError(error)) {
    throw new StreamReceiverUnavailableError(
      `project worker receiver was canceled before acknowledgement: ${error.message}`,
      { cause: error },
    );
  }
  throw error;
}

function disposeAcknowledgedRpcResult(result: unknown, operation: string) {
  try {
    disposeIgnoredRpcResult(result);
  } catch (error) {
    // The remote call already committed. Cleanup must stay visible without
    // turning its acknowledgement into a retry of the same durable work.
    console.warn("stream internal RPC result dispose failed after acknowledgement", {
      operation,
      error,
    });
  }
}

/** Build the four concrete calls used by the receiver union. */
function createSubscriptionReceiverCalls(deps: {
  projectId: string | null;
  exports: unknown;
  createAuthorityRoot(): unknown;
  copyToStream(path: string, batch: StreamDeliveryBatch): Promise<CopyReceipt>;
  onHostedDeliveryError(
    subscriptionKey: string,
    error: unknown,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): void;
}): SubscriptionReceiverCalls {
  let webhookEgress: ReturnType<typeof projectEgressFetcher> | undefined;

  const evaluateItxDelivery = async (expression: ItxExpression, batch: StreamDeliveryBatch) => {
    let value: unknown;
    try {
      ({ value } = await evaluateItxExpression(
        deps.createAuthorityRoot(),
        toInvocation(expression, batch),
      ));
    } catch (error) {
      rethrowItxDeliveryError(error);
    }
    try {
      disposeIgnoredRpcResult(value);
    } catch (error) {
      // The completed call is the acknowledgement. Cleanup failure is visible,
      // but must not retry and send the same batch twice.
      console.warn("ITX stream delivery result dispose failed after acknowledgement", { error });
    }
  };

  return {
    async wakeStreamProcessor(
      expression: ItxExpression,
      request: StreamProcessorWakeRequest,
      expectedDelivery: ExpectedHostedDeliveryState,
    ) {
      const { value } = await evaluateItxExpression(
        deps.createAuthorityRoot(),
        toInvocation(expression, request),
      );
      return retainProcessorWakeResponse({
        value,
        onDeliveryError: (error) =>
          deps.onHostedDeliveryError(request.subscriptionKey, error, expectedDelivery),
      });
    },

    async deliverToItx(expression: ItxExpression, batch: StreamDeliveryBatch) {
      await evaluateItxDelivery(expression, batch);
    },

    async copyToStream(path: string, batch: StreamDeliveryBatch) {
      const result = await deps.copyToStream(path, batch);
      const receipt = { acknowledged: result.acknowledged };
      disposeAcknowledgedRpcResult(result, "copy-to-stream");
      return receipt;
    },

    async deliverToWebhook(url: string, delivery: StreamWebhookDelivery) {
      if (deps.projectId === null) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      webhookEgress ??= projectEgressFetcher(
        deps.exports as ExecutionContext["exports"],
        deps.projectId,
        { kind: "scope", scopePath: "/" },
      );
      const egress = webhookEgress;
      try {
        const response = await egress.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(delivery),
        });
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`webhook responded ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        if (webhookEgress === egress) webhookEgress = undefined;
        (egress as Partial<Disposable>)[Symbol.dispose]?.();
        throw error;
      }
    },
  };
}

/** Turn the final property step into a receiver-bound method call. */
function toInvocation(expression: ItxExpression, payload: unknown): ItxExpression {
  const methodName = expression.at(-1);
  if (typeof methodName !== "string") {
    throw new Error("delivery expression must end in a property step naming the method to invoke");
  }
  return [...expression.slice(0, -1), [methodName, payload]];
}

/**
 * The subscription key of the worker feed every project-scoped stream uses.
 * Child streams configure it at birth. The project creation saga configures
 * it on `/` only after the seeded default worker has built.
 */
const PROJECT_WORKER_SUBSCRIPTION_KEY = "project-worker";

/**
 * Durable stream storage plus the stream's own ("core") processor.
 *
 * The pieces, in the order they appear below:
 *
 * 1. `append(...)` — the synchronous commit point. Offsets are assigned, the
 *    core state is reduced, and event rows are persisted in one await-free
 *    turn; everything after that is post-commit callback and subscription work.
 * 2. The core processor — synchronous `validate` → `reduce`, with
 *    contract/schemas in `core-processor-contract.ts`. Runtime delivery is
 *    reconciled from the resulting state after commit rather than dispatched
 *    from one-shot event hooks.
 * 3. Its checkpoint — reduced state in DO KV, rebuilt from the SQL event log
 *    (`stream-storage.ts`) when missing or version-skewed.
 * 4. Delivery — session callbacks, hosted processors, copies, ITX calls,
 *    and webhooks live in `stream-event-sender.ts`, calling receivers through
 *    `createSubscriptionReceiverCalls` above; this class only decides policy
 *    (who may connect, what a subscription event means, which events to append).
 *
 * HTTP/WebSocket Cap'n Web termination belongs at the fronting Worker, which
 * exposes this DO through `StreamRpcTarget`. This class is deliberately NOT
 * `implements Stream`: `Stream` is the public async capability; the methods
 * here are storage/runtime implementation methods, and the append/read methods
 * that touch SQLite/KV must remain synchronous.
 */
export class StreamDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  #liveState!: LiveState<StreamRuntimeDebugState>;
  #liveStateRefreshScheduled = false;
  readonly name = parseStreamDurableObjectName(this.ctx.id.name);
  readonly #log = new StreamEventLog(this.ctx.storage.sql, this.name.path);
  /**
   * Durable subscription cursor rows. A field (not inlined into the hooks)
   * because the core-state rebuild path removes rows whose configuration no
   * longer exists — see #readCoreProcessorState.
   */
  readonly #subscriptionCursorStore = new SqliteSubscriptionCursorStore(this.ctx.storage.sql, {
    onMutation: () => this.#refreshLiveState(),
  });
  /** In-memory throughput accounting (events/s, bytes in/out); resets with the incarnation. */
  readonly #metrics = new StreamRuntimeMetrics(Date.now());
  readonly #alarmArmer = new StreamAlarmArmer(this.ctx.storage);
  readonly #deliveryAlarmBoundary = new StreamDeliveryAlarmBoundary({
    armAlarm: (atMs) => this.#alarmArmer.armNoLaterThan(atMs),
    now: () => Date.now(),
    waitUntil: (work) => this.ctx.waitUntil(work),
  });
  readonly #eventSender = new StreamEventSender({
    idleTeardownMs: idleTeardownMs(this.env),
    hooks: {
      // Straight to the sized log read: delivery needs byte lengths for its
      // batch cap (getEvents would re-stringify to size a batch), and its
      // limits are already bounded well under the public read clamp.
      readEvents: (args) =>
        this.#log.getRangeSized({
          afterOffset: args.afterOffset,
          beforeOffset: args.beforeOffset,
          limit: args.limit,
          // RAW, ephemeral included: durable cursors advance over every
          // offset (skip-not-defer, like filter-excluded events); durable
          // subscriptions never deliver them.
          includeEphemeral: true,
        }),
      coreState: () => this.#coreProcessorState,
      store: this.#subscriptionCursorStore,
      receiverCalls: createSubscriptionReceiverCalls({
        projectId: this.name.projectId,
        exports: this.ctx.exports,
        createAuthorityRoot: () => this.#createEventDeliveryAuthorityRoot(),
        copyToStream: (path, batch) => this.#streamStub(path).receiveCopiedEvents(batch),
        onHostedDeliveryError: (subscriptionKey, error, expectedDelivery) =>
          this.#eventSender.connections.onHostedDeliveryError(
            subscriptionKey,
            error,
            expectedDelivery,
          ),
      }),
      appendDeliveryEvent: (event) => {
        // A lifecycle interruption is expected while this incarnation is
        // disappearing and is reported to the caller for retry. Every other
        // append failure is an unexplained product defect and propagates.
        try {
          this.#append({ authority: "core-event" }, [event]);
          return true;
        } catch (error) {
          if (isDurableObjectLifecycleError(error)) {
            console.info("stream delivery event append interrupted by durable object lifecycle", {
              message: error instanceof Error ? error.message : String(error),
              type: event.type,
            });
            return false;
          }
          throw error;
        }
      },
      recordEgress: (count, bytes) => {
        this.#metrics.egress.bump(Date.now(), count, bytes);
        this.#refreshLiveState();
      },
      runtimeChanged: () => this.#refreshLiveState(),
      now: () => Date.now(),
      random: () => Math.random(),
      armAlarm: (atMs) => this.#alarmArmer.armNoLaterThan(atMs),
      runDurable: (work) => this.#deliveryAlarmBoundary.scheduleOrRun(work),
      keepAlive: (promise) => this.#runInBackground(() => promise),
      hasWakeChannel: (connectionKey) => this.#wakeSockets(connectionKey).length > 0,
      recordSessionIdleClosed: (connectionKeys) => {
        const maxOffset = this.#coreProcessorState.maxOffset;
        const idled = new Set(connectionKeys);
        for (const { ws, attachment } of this.#wakeSockets()) {
          if (!idled.has(attachment.connectionKey)) continue;
          const { wakeSentAtOffset: _cleared, ...rest } = attachment;
          ws.serializeAttachment({
            ...rest,
            idleDeliveredThrough: maxOffset,
          } satisfies WakeSocketAttachment);
          // Closing the RPC leg released the retained callback, but the
          // relay still holds its StreamConnectionHandle stub — a live
          // reference into this isolate that blocks hibernation on its own.
          // The idle frame tells the relay to dispose it (wake-socket.ts);
          // best-effort, since a broken socket already means the relay's
          // execution context (and with it the stub) is gone.
          try {
            ws.send(JSON.stringify({ type: "idle" }));
          } catch (error) {
            console.warn("stream idle frame send failed", {
              connectionKey: attachment.connectionKey,
              error,
            });
          }
        }
      },
    },
  });
  #coreProcessorState: CoreProcessorState;
  #invalidCheckpointError: unknown = undefined;
  readonly #coreProcessor = new StreamCoreProcessor({
    projectId: this.name.projectId,
  });
  #consecutiveReconciliationFailures = 0;

  /**
   * Creates a fresh in-isolate root for one stream delivery evaluation. It
   * carries narrowly branded delivery auth and owns no Workers RPC lifetime.
   */
  #createEventDeliveryAuthorityRoot(): unknown {
    const auth = streamDeliveryAuthContext(this.name.projectId);
    return this.name.projectId === null
      ? deploymentItxForInternal({ auth, ctx: this.ctx })
      : itxForScope({
          auth,
          ctx: this.ctx,
          streamContext: { kind: "scope", scopePath: "/" },
          path: "/",
          projectId: this.name.projectId,
        });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const loaded = this.#readCoreProcessorState();
    if (loaded.kind === "ready") {
      this.#coreProcessorState = loaded.state;
      this.#finishInitialization();
      return;
    }

    // Only a missing, invalid, or old-version checkpoint takes the async
    // initialization lane. blockConcurrencyWhile keeps every RPC/alarm out
    // until the rebuilt state has been promoted, while the replay itself can
    // await storage.sync() between bounded chunks. Those awaits are the real
    // transaction boundaries that make progress survive a 30-second
    // initialization reset.
    this.#coreProcessorState = CoreProcessorContract.stateSchema.parse({});
    void this.ctx.blockConcurrencyWhile(async () => {
      this.#coreProcessorState = await this.#recoverCoreProcessorStateFromEventLog();
      this.#finishInitialization();
    });
  }

  #finishInitialization(): void {
    this.#liveState = new LiveState(this.#readRuntimeState());

    // The first boot appends the stream's birth certificate; every wake
    // (fetch, RPC, alarm) appends a `woken` event, whose post-commit sends are
    // also what re-establishes durable deliveries after hibernation.
    //
    // Child project streams are born with their ordinary platform feeds. The
    // root is deliberately different: its project-worker feed is installed by
    // the project creation saga only after the seeded worker has built. That
    // keeps an unavailable worker from looking broken during its own build;
    // project/created means the worker was reachable and its permanent feed
    // was committed, not that userspace consumed a platform creation event.
    if (this.#coreProcessorState.eventCount === 0) {
      this.#append({ authority: "core-event" }, [
        {
          type: "events.iterate.com/stream/created",
          payload: {
            projectId: this.name.projectId,
            path: this.name.path,
            streamId: crypto.randomUUID(),
          },
        },
      ]);
      // The standalone streams playground reuses this DO without hosting a
      // project worker. Do not invent a fake callback owner there: OS's PROJECT
      // binding is the capability that makes this feed real.
      if (this.name.projectId !== null && "PROJECT" in this.env) {
        if (this.name.path !== "/") {
          this.append({
            type: "events.iterate.com/stream/subscription-configured",
            payload: {
              subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
              receiver: {
                action: "itx-call",
                expression: ["processEventBatch"],
                delivery: {
                  // Everything, from the beginning: the worker sees the
                  // stream's full history once it first builds.
                  start: "beginning",
                  // One failing event must not silence a project's entire feed.
                  onFailingEvent: "skip",
                },
              },
            } satisfies SubscriptionConfiguredPayload,
          });
        }
        // The standalone streams playground also has no PostHog credential or
        // receiver. Deployed OS environments require the credential, so its
        // presence is the integration boundary.
        if ("APP_CONFIG_POSTHOG" in this.env) this.append(posthogSubscriptionEvent());
      }
    }
    if (this.#invalidCheckpointError !== undefined) {
      console.error("stream core-state checkpoint was invalid; rebuilt from the event log", {
        path: this.name.path,
        stateVersion: CORE_STATE_VERSION,
        error: this.#invalidCheckpointError,
      });
      this.#append({ authority: "core-event" }, [
        {
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: internalStreamId(
            "invalid-core-state-checkpoint-rebuilt",
            CORE_STATE_VERSION,
            this.#coreProcessorState.maxOffset,
          ),
          payload: {
            message: `core-state checkpoint for ${this.name.path} failed validation under version ${CORE_STATE_VERSION}; rebuilt from the event log`,
          },
        },
      ]);
    }
    this.#append({ authority: "core-event" }, [
      {
        type: "events.iterate.com/stream/woken",
        payload: { incarnationId: crypto.randomUUID() },
      },
    ]);
  }

  /** Use Cloudflare's native alarm invocation as the trace root; retry work remains background. */
  alarm(): void {
    this.#alarmArmer.markFired();
    this.#deliveryAlarmBoundary.runAlarmTurn(() => {
      this.#reconcileCommittedState({ alarmTurn: true });
    });
  }

  // ===========================================================================
  // Append: the commit point.
  // ===========================================================================

  /**
   * Synchronously assigns offsets, reduces, persists, then wakes delivery.
   *
   * DO NOT make this method async. Do not insert an `await` anywhere in the
   * offset/reduce/persist path it calls. This is the stream's commit point:
   * storage writes and core state changes must happen in one synchronous turn.
   *
   * What happens for `append(a, b)` on a stream at `maxOffset: 4`:
   * 1. `a` becomes offset 5, `b` becomes offset 6; each passes `validate`
   *    and is folded through `reduce`. An event whose `idempotencyKey` already
   *    exists is skipped and the existing event is returned in its place (so
   *    the returned array stays input-aligned).
   * 2. Event rows + the new core state are written in one await-free turn.
   *    After this line the append has succeeded.
   * 3. Post-commit work reconciles runtime delivery from the new reduced state.
   *    Failures are reported and get an immediate durable repair alarm; they
   *    cannot change the already-committed append result.
   *
   * Returns the persisted events (including offsets + `createdAt`) in input order.
   */
  append(...eventInputs: StreamEventInput[]): StreamEvent[] {
    return this.#append({ authority: "public" }, eventInputs);
  }

  /**
   * Commit only while this path still names `streamId`. The identity check is
   * synchronous with the append commit, which closes the read-then-append race
   * for work retained across a stream deletion and recreation.
   */
  appendIfStreamId(args: { streamId: string; events: StreamEventInput[] }): StreamEvent[] {
    if (args.streamId.trim().length === 0) {
      throw new Error("streamId must be a non-empty string");
    }
    const currentStreamId = this.#coreProcessorState.streamId;
    if (currentStreamId !== args.streamId) {
      throw new StreamIdMismatchError(streamIdMismatchMessage(args.streamId, currentStreamId));
    }
    return this.#append({ authority: "public" }, args.events);
  }

  /** Internal platform append, atomically fenced to one stream lifetime. */
  appendCoreEventsIfStreamId(args: {
    streamId: string;
    events: StreamEventInput[];
  }): StreamEvent[] {
    if (args.streamId.trim().length === 0) {
      throw new Error("streamId must be a non-empty string");
    }
    const currentStreamId = this.#coreProcessorState.streamId;
    if (currentStreamId !== args.streamId) {
      throw new StreamIdMismatchError(streamIdMismatchMessage(args.streamId, currentStreamId));
    }
    return this.#append({ authority: "core-event" }, args.events);
  }

  /**
   * Commit one copy subscription on this source stream and return the
   * committed configuration event. No probe call, no confirmation wait: the
   * receiver learns about the subscription when its first copy arrives, and
   * a broken receiver surfaces later as a durable halt.
   *
   * A caller-supplied key means "ensure/replace this source-local
   * subscription" — an identical configuration is level-triggered and returns
   * the existing committed event without moving the cursor. An omitted key
   * always means "create another subscription"; its effective key is derived
   * from the committed event offset, so a keyless command must supply an
   * event idempotency key to make a retry unable to create a duplicate.
   */
  setCopySubscription(args: {
    configuration: SubscriptionConfiguredPayload;
    idempotencyKey?: string;
  }): {
    subscriptionKey: string;
    subscriptionConfiguredEvent: CommittedSubscriptionConfiguredEvent;
  } {
    const canonical = CoreProcessorContract.parseEventInput({
      type: "events.iterate.com/stream/subscription-configured",
      payload: args.configuration,
    }).payload;
    if (canonical.receiver.action !== "copy-to-stream") {
      throw new Error("setCopySubscription requires a copy action");
    }
    if (canonical.subscriptionKey === undefined && args.idempotencyKey === undefined) {
      throw new Error(
        "a keyless copy subscription requires idempotencyKey so setup is safe to retry",
      );
    }

    const explicitSubscriptionKey = canonical.subscriptionKey;
    const existing =
      explicitSubscriptionKey === undefined
        ? undefined
        : this.#coreProcessorState.subscriptions.outbound.byKey[explicitSubscriptionKey];

    let configuredEvent: StreamEvent;
    if (existing !== undefined && jsonValuesEqual(existing.configuration, canonical)) {
      const event = this.getEvent({ offset: existing.configuredAtOffset });
      if (event?.type !== "events.iterate.com/stream/subscription-configured") {
        throw new Error(
          `subscription "${explicitSubscriptionKey}" points to a missing configuration event at offset ${existing.configuredAtOffset}`,
        );
      }
      // A halted subscription still satisfies an identical ensure: the durable
      // instruction is already correct, and the halt is delivery state with
      // its own repair verbs. Throwing here would fail automated retries
      // (linkGithub, birth replays) that only need the existing event back.
      configuredEvent = event;
    } else {
      configuredEvent = this.#append({ authority: "public" }, [
        {
          type: "events.iterate.com/stream/subscription-configured",
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          payload: canonical,
        },
      ])[0]!;
    }

    const subscriptionConfiguredEvent = parseCommittedCoreEvent(
      configuredEvent,
      "events.iterate.com/stream/subscription-configured",
    );
    return {
      subscriptionKey: subscriptionKeyForConfiguredEvent(subscriptionConfiguredEvent),
      subscriptionConfiguredEvent,
    };
  }

  /** Internal platform-event append used only by sibling Stream Durable Objects. */
  appendCoreEvent(eventInput: StreamEventInput): StreamEvent {
    return this.#append({ authority: "core-event" }, [eventInput])[0]!;
  }

  /** Internal atomic platform-event append used by deterministic live fault injection. */
  appendCoreEvents(eventInputs: StreamEventInput[]): StreamEvent[] {
    return this.#append({ authority: "core-event" }, eventInputs);
  }

  /**
   * Source-side removal command for a copy. Await-free: validation and append
   * share one DO turn, so a same-key replacement cannot be removed through a
   * stale ownership read. Repeated calls are level-triggered, and a
   * replacement owned by a different receiver is protected by
   * `expectedReceiverPath`.
   */
  removeCopySubscription(args: {
    subscriptionKey: string;
    expectedReceiverPath: string;
  }):
    | { status: "removed"; subscriptionRemovedEvent: CommittedSubscriptionRemovedEvent }
    | { status: "already-absent" } {
    const removal = CoreProcessorContract.parseEventInput({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { subscriptionKey: args.subscriptionKey, reason: "requested" },
    }).payload;
    const subscriptionKey = removal.subscriptionKey;
    const expectedReceiverPath = canonicalizeStreamPath(args.expectedReceiverPath);
    const configured = this.#coreProcessorState.subscriptions.outbound.byKey[subscriptionKey];
    if (
      configured === undefined ||
      configured.configuration.receiver.action !== "copy-to-stream" ||
      configured.configuration.receiver.receivingStreamPath !== expectedReceiverPath
    ) {
      return { status: "already-absent" };
    }
    return {
      status: "removed",
      subscriptionRemovedEvent: parseCommittedCoreEvent(
        this.#append({ authority: "public" }, [
          {
            type: "events.iterate.com/stream/subscription-removed",
            payload: { subscriptionKey, reason: "requested" },
          },
        ])[0]!,
        "events.iterate.com/stream/subscription-removed",
      ),
    };
  }

  #append(
    options: {
      authority: "public" | "core-event" | "copy";
    },
    eventInputs: readonly StreamEventInput[],
  ): StreamEvent[] {
    let workingState = this.#coreProcessorState;
    const events: StreamEvent[] = [];
    const newEvents: StreamEvent[] = [];
    const idempotencyHitsInBatch = new Map<string, StreamEvent>();

    // 1. Validate inputs, assign offsets, and reduce state.
    for (const eventInput of eventInputs) {
      // `offset` is an optional optimistic-concurrency assertion, not part of the
      // event body. Split it off immediately so it never reaches core-event
      // validation or the committed event: `validate` strict-parses the
      // body against the contract schema, which has no `offset` key, so leaving
      // it attached made every asserted append of a core policy event fail with
      // a spurious "Unrecognized key: offset" instead of performing the assertion.
      const { offset: expectedOffset, ...parsedBody } = StreamAppendInput.parse(eventInput);
      const body = this.#coreProcessor.canonicalize(parsedBody);

      // This check deliberately precedes the idempotency lookup. Otherwise a
      // public caller could supply a platform key that already exists and have
      // the lookup return that trusted event before validation runs.
      if (options.authority === "public" && isInternalStreamIdempotencyKey(body.idempotencyKey)) {
        throw new Error("iterate-internal idempotency keys are platform-authored");
      }

      if (body.idempotencyKey !== undefined) {
        // Same-batch idempotency should behave like already-persisted idempotency.
        const existing =
          idempotencyHitsInBatch.get(body.idempotencyKey) ??
          this.getEvent({ idempotencyKey: body.idempotencyKey });
        if (existing !== undefined) {
          if (expectedOffset !== undefined && expectedOffset !== existing.offset) {
            throw new Error(`idempotency hit at offset ${existing.offset}, got ${expectedOffset}`);
          }
          if (options.authority === "copy") {
            // Copied product-event copies are identified by their final
            // source hop. The receiver's own drop-audit records have no hop;
            // their deterministic body and internal key are the complete
            // identity.
            const isSameCopyAppend =
              body.source?.copiedFrom?.at(-1) === undefined
                ? sameIdempotentEvent(existing, body)
                : sameCopiedEventIdentity(existing, body);
            if (isSameCopyAppend) {
              events.push(existing);
              continue;
            }
            // Copy keys name source coordinates, not merely an event
            // body. Never let a pre-existing ordinary append masquerade as a
            // successful delivery just because type/payload happen to match.
            throw new Error(idempotencyConflictMessage(body.idempotencyKey, existing.offset));
          }
          if (!sameIdempotentEvent(existing, body)) {
            throw new Error(idempotencyConflictMessage(body.idempotencyKey, existing.offset));
          }
          events.push(existing);
          continue;
        }
      }

      this.#coreProcessor.validate({
        event: body,
        state: workingState,
        authority: options.authority,
      });

      const committed: StreamEvent = {
        ...body,
        offset: workingState.maxOffset + 1,
        createdAt: new Date().toISOString(),
        path: this.name.path,
      };
      if (expectedOffset !== undefined && expectedOffset !== committed.offset) {
        throw new StreamOffsetConflictError(
          streamOffsetConflictMessage(expectedOffset, committed.offset),
        );
      }
      if (
        options.authority === "public" &&
        committed.source?.copiedFrom === undefined &&
        committed.type === "events.iterate.com/stream/subscription-configured"
      ) {
        const configured = parseCommittedCoreEvent(
          committed,
          "events.iterate.com/stream/subscription-configured",
        );
        const subscriptionKey = subscriptionKeyForConfiguredEvent(configured);
        if (this.#eventSender.connections.connectionKind(subscriptionKey) === "session") {
          throw new Error(
            `subscriptionKey "${subscriptionKey}" is already used by a live session connection`,
          );
        }
      }

      workingState = this.#coreProcessor.reduce({ event: committed, state: workingState });

      events.push(committed);
      newEvents.push(committed);
      if (committed.idempotencyKey !== undefined) {
        idempotencyHitsInBatch.set(committed.idempotencyKey, committed);
      }
    }

    if (newEvents.length === 0) return events;

    // 2. Persist event rows and advance the in-memory reduction. Durable Object
    // SQL storage runs synchronously in the object's thread; each sql.exec() is
    // atomic and Output Gates hold responses until writes are durable:
    // https://developers.cloudflare.com/durable-objects/api/sql-storage/
    // https://blog.cloudflare.com/sqlite-in-durable-objects/
    // Keep this section await-free: the event rows are the append boundary.
    // The KV state checkpoint is DEBOUNCED (see
    // #checkpointCoreProcessorState) — event rows are the durable truth, and
    // boot catch-up folds past a lagging checkpoint by design.
    assertCoreProcessorCheckpointGrowthFits({
      before: this.#coreProcessorState,
      events: newEvents,
      next: workingState,
    });
    const byteLengths = this.#log.insert(newEvents);
    this.#coreProcessorState = workingState;
    this.#checkpointCoreProcessorState(newEvents.length);
    this.#metrics.ingress.bump(
      Date.now(),
      newEvents.length,
      byteLengths.reduce((sum, bytes) => sum + bytes, 0),
    );
    this.#refreshLiveState();

    // 3. Reconcile every mutable/runtime projection from the committed state.
    // Each operation is isolated so one defect cannot skip its siblings. Any
    // failure gets an immediate native alarm in this same output-gated turn;
    // the alarm and a fresh incarnation both run the same level checks.
    this.#reconcileCommittedState({
      justCommittedEvents: newEvents.map((event, index) => ({
        event,
        byteLength: byteLengths[index]!,
      })),
    });

    return events;
  }

  /**
   * Synchronous committed-event read used by the append transaction and
   * delivery catch-up. Keep await-free; callers that cross an RPC seam get the
   * async shape from `StreamRpcTarget`, not from this storage method.
   */
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined {
    if (args.idempotencyKey !== undefined)
      return this.#log.getByIdempotencyKey(args.idempotencyKey);
    return this.#log.getByOffset(args.offset);
  }

  /**
   * Synchronous committed-event range read. Keep await-free (see getEvent).
   * Ephemeral rows are excluded unless `includeEphemeral` — the second-class
   * contract: nothing reads them by accident, so the stream stays free to
   * evict them later.
   */
  getEvents(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      eventTypes?: readonly string[];
      limit?: number;
      includeEphemeral?: boolean;
    } = {},
  ): StreamEvent[] {
    const limit = args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("getEvents limit must be a positive integer.");
    }
    if (limit !== undefined && limit > MAX_GET_EVENTS_LIMIT) {
      throw new Error(`getEvents limit must be at most ${MAX_GET_EVENTS_LIMIT}.`);
    }
    return this.#log.getRange({
      afterOffset: args.afterOffset ?? 0,
      beforeOffset: args.beforeOffset ?? Number.MAX_SAFE_INTEGER,
      eventTypes: args.eventTypes,
      limit: limit ?? DEFAULT_GET_EVENTS_LIMIT,
      includeEphemeral: args.includeEphemeral,
    });
  }

  /**
   * Read one event page and the stream lifetime that owns its offsets in the
   * same synchronous Durable Object turn. A separate identity read could race
   * a stream recreation between calls.
   */
  getEventPage(
    args: {
      afterOffset?: number;
      beforeOffset?: number | null;
      eventTypes?: readonly string[];
      limit?: number;
      includeEphemeral?: boolean;
    } = {},
  ): { streamId: string; streamMaxOffset: number; events: StreamEvent[] } {
    const streamId = this.#coreProcessorState.streamId;
    if (streamId === undefined) {
      throw new Error("stream identity is unavailable after stream creation");
    }
    return {
      streamId,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
      events: this.getEvents(args),
    };
  }

  /** The committed maximum offset used to pin a recoverable public wait's replay cursor. */
  getMaxOffset(): number {
    return this.#coreProcessorState.maxOffset;
  }

  /**
   * Both maximum offsets in one read, for exact-offset CAS appends that also need a
   * fold barrier: `maxOffset` is the highest assigned offset (ephemeral rows hold
   * offsets too — the CAS target), while `maxDurableOffset` is the latest offset a
   * default catch-up can actually fold through — the only maximum offset a
   * `waitUntilEvent` barrier can be pinned to without wedging on a trailing
   * ephemeral suffix that processor reads never see.
   */
  getMaxOffsets(): { maxDurableOffset: number; maxOffset: number } {
    return {
      maxDurableOffset: this.#log.highestDurableOffset(),
      maxOffset: this.#coreProcessorState.maxOffset,
    };
  }

  // Core validation and reduction live in core-processor.ts. This Durable
  // Object reconciles mutable delivery state after the durable commit.

  #ancestorsAnnouncedThisIncarnation = false;
  #ancestorAnnouncementInFlight = false;

  /**
   * Bring every mutable delivery projection into line with current reduced
   * state. Each operation is level-triggered and safe to run again after an
   * interruption, eviction, or alarm retry.
   */
  #reconcileCommittedState(args: {
    alarmTurn?: boolean;
    justCommittedEvents?: Parameters<StreamEventSender["sendDue"]>[0];
  }): void {
    let repairNeeded = false;
    const attempt = (operation: string, work: () => void | boolean) => {
      try {
        if (work() === false) repairNeeded = true;
      } catch (error) {
        repairNeeded = true;
        console.error("stream post-commit reconciliation failed", { operation, error });
      }
    };

    attempt("append circuit-breaker pause", () => this.#appendOwedCircuitBreakerPause());
    attempt("announce stream to ancestors", () => this.#announceToAncestors());
    attempt("send pending events", () =>
      args.alarmTurn === true
        ? this.#eventSender.onAlarm()
        : this.#eventSender.sendDue(args.justCommittedEvents),
    );
    attempt("wake dormant session subscribers", () =>
      this.#wakeDormantSessionSubscribers(args.justCommittedEvents),
    );
    attempt("arm connection idle alarm", () => this.#eventSender.connections.armOrClearIdleAlarm());
    if (args.alarmTurn === true) {
      attempt("flush core state checkpoint", () => this.#flushCoreProcessorState());
    }

    if (repairNeeded) {
      // This setAlarm write deliberately remains uncaught. The output gate
      // suppresses the append response if durable repair cannot be recorded;
      // returning success with neither applied effects nor a future turn would
      // violate the stream's commit contract.
      this.#consecutiveReconciliationFailures += 1;
      this.#alarmArmer.armNoLaterThan(
        Date.now() + computeBackoffMs(this.#consecutiveReconciliationFailures, Math.random()),
      );
    } else {
      this.#consecutiveReconciliationFailures = 0;
    }
  }

  #appendOwedCircuitBreakerPause(): void {
    const tripOffset = this.#coreProcessorState.circuitBreaker.trippedAtOffset;
    if (tripOffset === null || this.#coreProcessorState.paused) return;
    this.#append({ authority: "core-event" }, [
      {
        type: "events.iterate.com/stream/paused",
        idempotencyKey: internalStreamId("stream-paused", tripOffset),
        payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
      },
    ]);
  }

  /** Tell every ancestor stream (up to the root) that this stream exists. */
  #announceToAncestors(): void {
    if (this.#ancestorsAnnouncedThisIncarnation || this.#ancestorAnnouncementInFlight) return;
    const path = this.#coreProcessorState.path;
    if (path === undefined || path === "/") {
      this.#ancestorsAnnouncedThisIncarnation = true;
      return;
    }

    const pathSegments = path.split("/").filter(Boolean);
    const ancestorPaths = ["/"];
    for (let index = 1; index < pathSegments.length; index += 1) {
      ancestorPaths.push(`/${pathSegments.slice(0, index).join("/")}`);
    }

    this.#ancestorAnnouncementInFlight = true;
    this.#runInBackground(async () => {
      try {
        await Promise.all(
          ancestorPaths.map((ancestorPath) =>
            this.#appendCoreEventToStreamPath(ancestorPath, {
              type: "events.iterate.com/stream/child-stream-created",
              idempotencyKey: internalStreamId("child-stream-created", ancestorPath, path),
              payload: { childPath: path },
            }),
          ),
        );
        this.#ancestorsAnnouncedThisIncarnation = true;
      } finally {
        this.#ancestorAnnouncementInFlight = false;
      }
    });
  }

  #streamStub(path: string) {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify(
        { projectId: this.name.projectId, path },
        { allowNullProjectId: true },
      ),
    );
  }

  /**
   * Receive events from another stream. Adding `source.copiedFrom`, the
   * inbound stamp fence, cycle prevention, and idempotency keys live in
   * `copy-appends.ts`; this method
   * only appends the built inputs in its own synchronous turn.
   */
  receiveCopiedEvents(batch: StreamDeliveryBatch): CopyReceipt {
    const { inputs, receipt } = buildCopyAppends({
      batch,
      self: { projectId: this.name.projectId, path: this.name.path },
      inbound: this.#coreProcessorState.subscriptions.inbound.bySourcePath[batch.path],
    });
    if (inputs.length > 0) {
      this.#append({ authority: "copy" }, inputs);
    }
    return receipt;
  }

  async #appendCoreEventToStreamPath(path: string, event: StreamEventInput) {
    const result = await this.#streamStub(path).appendCoreEvent(event);
    disposeAcknowledgedRpcResult(result, "ancestor-core-event");
  }

  #runInBackground(work: () => Promise<unknown>): void {
    this.ctx.waitUntil(settleStreamCoreBackgroundWork(work));
  }

  // ===========================================================================
  // Core state checkpoint: reduced state in KV, rebuilt from the event log.
  // ===========================================================================

  #readCoreProcessorState(): { kind: "ready"; state: CoreProcessorState } | { kind: "rebuild" } {
    const stored = this.ctx.storage.kv.get<unknown>("state");
    const storedVersion = this.ctx.storage.kv.get<unknown>("stateVersion") ?? 1;
    // State persisted by a reducer of a different version is incomplete (it
    // was reduced before newer derived fields existed), so it is discarded and
    // rebuilt from the event log rather than trusted.
    if (stored !== undefined && storedVersion === CORE_STATE_VERSION) {
      const parsed = CoreProcessorContract.stateSchema.safeParse(stored);
      if (parsed.success) {
        this.#deleteCoreStateRebuildCheckpoint();
        const state = this.#catchUpCoreProcessorState(parsed.data);
        const configuredSubscriptionKeys = new Set(Object.keys(state.subscriptions.outbound.byKey));

        // A lifecycle interruption can land after a removal event commits but
        // before its post-commit cursor cleanup. Reduced source configuration
        // is authoritative on every boot, not only after a reducer-version
        // migration.
        pruneOrphanedSubscriptionCursorRows(
          this.#subscriptionCursorStore,
          configuredSubscriptionKeys,
        );

        if (state.maxOffset !== parsed.data.maxOffset) {
          this.#writeCoreProcessorState(state);
        }
        return { kind: "ready", state };
      }
      this.#invalidCheckpointError = parsed.error;
    }

    if (this.#log.highestOffset() === 0) {
      this.#deleteCoreStateRebuildCheckpoint();
      return { kind: "ready", state: CoreProcessorContract.stateSchema.parse({}) };
    }
    return { kind: "rebuild" };
  }

  #stateVersionWritten = false;
  /** True while `#coreProcessorState` is ahead of the KV checkpoint. */
  #checkpointDirty = false;
  #eventsSinceCheckpoint = 0;
  #checkpointWrittenAtMs = 0;
  /** Debounce bounds: checkpoint at least every N events / T ms of appends. */
  static readonly #CHECKPOINT_EVERY_EVENTS = 64;
  static readonly #CHECKPOINT_MAX_LAG_MS = 1_000;

  /**
   * The debounced per-append checkpoint. Serializing the full core state into
   * KV on EVERY append is O(state) write amplification per event — on a busy
   * agent stream the state (config payloads, roster) easily outweighs the
   * event. Event rows are the commit boundary and the durable truth; the KV
   * checkpoint is a rebuild accelerator, and boot ALWAYS folds log rows past
   * it (`#catchUpCoreProcessorState`, paged) — so a checkpoint that lags by a
   * bounded window (64 events / 1s) costs a small constructor fold, never
   * correctness. Alarm and idle teardown flush so a stream going quiet
   * checkpoints before it hibernates.
   */
  #checkpointCoreProcessorState(newEventCount: number): void {
    this.#eventsSinceCheckpoint += newEventCount;
    const now = Date.now();
    if (
      this.#eventsSinceCheckpoint < StreamDurableObject.#CHECKPOINT_EVERY_EVENTS &&
      now - this.#checkpointWrittenAtMs < StreamDurableObject.#CHECKPOINT_MAX_LAG_MS
    ) {
      this.#checkpointDirty = true;
      return;
    }
    this.#writeCoreProcessorState(this.#coreProcessorState);
  }

  /** Write the checkpoint now if the in-memory state is ahead of it. */
  #flushCoreProcessorState(): void {
    if (this.#checkpointDirty) this.#writeCoreProcessorState(this.#coreProcessorState);
  }

  #writeCoreProcessorState(state: CoreProcessorState): void {
    this.ctx.storage.kv.put("state", state);
    this.#checkpointDirty = false;
    this.#eventsSinceCheckpoint = 0;
    this.#checkpointWrittenAtMs = Date.now();
    // The version is a constant per deploy; re-putting it on every append is
    // pure write amplification. Once per incarnation is exactly as durable.
    if (!this.#stateVersionWritten) {
      this.ctx.storage.kv.put("stateVersion", CORE_STATE_VERSION);
      this.#stateVersionWritten = true;
    }
  }

  /** Reduce one bounded page, wrapping the exact historical row on failure. */
  #reduceNextCoreProcessorPage(
    state: CoreProcessorState,
    highestOffset: number,
  ): CoreProcessorState | undefined {
    const page = this.#log.getRange({
      afterOffset: state.maxOffset,
      beforeOffset: highestOffset + 1,
      limit: 500,
      // Ephemeral rows folded on append (counters + circuit breaker), so the
      // rebuild re-folds them. Exactly identical only while their rows
      // survive: a post-eviction rebuild counts fewer events and re-burns
      // fewer breaker tokens — bookkeeping drift, not correctness (see
      // eventCount's doc in core-processor-contract.ts).
      includeEphemeral: true,
    });
    if (page.length === 0) return undefined;

    let next = state;
    for (const event of page) {
      if (event.offset <= next.maxOffset) continue;
      try {
        next = this.#coreProcessor.reduce({ event, state: next });
      } catch (error) {
        throw new Error(
          `failed to replay core event at path "${this.name.path}", offset ${event.offset}, type "${event.type}", state version ${CORE_STATE_VERSION}`,
          { cause: error },
        );
      }
    }
    return next;
  }

  #applyHighestAssignedOffset(state: CoreProcessorState): CoreProcessorState {
    // The fold recovers maxOffset from surviving rows; the assigned floor
    // covers rows a future ephemeral eviction sweep deleted. Without it a
    // rebuild after the latest row was evicted would reissue offsets that live
    // open callbacks already received (the browser event table hard-ABORTs on a reused
    // offset carrying different JSON).
    const assignedFloor = this.#log.highestAssignedOffset();
    return assignedFloor > state.maxOffset ? { ...state, maxOffset: assignedFloor } : state;
  }

  /** Fold the small bounded tail after an ordinary current checkpoint. */
  #catchUpCoreProcessorState(state: CoreProcessorState): CoreProcessorState {
    const highestOffset = this.#log.highestOffset();
    let next = state;
    while (next.maxOffset < highestOffset) {
      const reduced = this.#reduceNextCoreProcessorPage(next, highestOffset);
      if (reduced === undefined) break;
      next = reduced;
    }
    return this.#applyHighestAssignedOffset(next);
  }

  /**
   * KV state is the fast path, but SQL rows are the durable source of truth.
   * If a deployed DO has rows but no (current-version) KV state, replay the
   * event log instead of treating the stream as empty and trying to insert
   * offset 1 again.
   */
  async #recoverCoreProcessorStateFromEventLog(): Promise<CoreProcessorState> {
    const highestOffset = this.#log.highestOffset();
    if (highestOffset === 0) {
      throw new Error("cannot rebuild core processor state from an empty event log");
    }
    let state =
      this.#readCoreStateRebuildCheckpoint() ?? CoreProcessorContract.stateSchema.parse({});
    let pagesReduced = 0;
    while (state.maxOffset < highestOffset) {
      const reduced = this.#reduceNextCoreProcessorPage(state, highestOffset);
      if (reduced === undefined) break;
      state = reduced;
      pagesReduced += 1;
      if (pagesReduced % CORE_STATE_REBUILD_CHECKPOINT_EVERY_PAGES === 0) {
        this.ctx.storage.kv.put(CORE_STATE_REBUILD_KEY, {
          stateVersion: CORE_STATE_VERSION,
          state,
        });
        // Synchronous SQL/KV writes before one JavaScript await share an
        // implicit transaction. This explicit flush is what makes the staged
        // replay state survive an initialization timeout or reset.
        await this.ctx.storage.sync();
      }
    }
    state = this.#applyHighestAssignedOffset(state);

    const configuredSubscriptionKeys = new Set(Object.keys(state.subscriptions.outbound.byKey));
    this.ctx.storage.transactionSync(() => {
      pruneOrphanedSubscriptionCursorRows(
        this.#subscriptionCursorStore,
        configuredSubscriptionKeys,
      );
      // The SQLite cursor rows survived the reducer-version change. Keep
      // monotonic acknowledged progress, but clear stale failure state so
      // every surviving subscription gets a fresh attempt under the new reducer.
      clearSubscriptionCursorFailuresAfterStateRebuild(
        this.#subscriptionCursorStore,
        configuredSubscriptionKeys,
      );
      this.#writeCoreProcessorState(state);
      this.#deleteCoreStateRebuildCheckpoint();
    });
    await this.ctx.storage.sync();
    return state;
  }

  #readCoreStateRebuildCheckpoint(): CoreProcessorState | undefined {
    const raw = this.ctx.storage.kv.get<unknown>(CORE_STATE_REBUILD_KEY);
    if (raw === undefined) return undefined;
    const version = z.object({ stateVersion: z.number().int() }).safeParse(raw);
    if (version.success && version.data.stateVersion !== CORE_STATE_VERSION) {
      // Expected deploy residue: a staged replay has exactly the same reducer
      // compatibility boundary as the promoted checkpoint. It cannot be
      // resumed under another version, but it is not evidence of corruption.
      this.#deleteCoreStateRebuildCheckpoint();
      return undefined;
    }
    const parsed = CoreStateRebuildCheckpoint.safeParse(raw);
    if (parsed.success) {
      const state = parsed.data.state;
      let creationMatches = false;
      try {
        const firstEvent = this.#log.getByOffset(1);
        if (firstEvent !== undefined) {
          const created = parseCommittedCoreEvent(firstEvent, "events.iterate.com/stream/created");
          creationMatches =
            created.payload.projectId === this.name.projectId &&
            created.payload.path === this.name.path &&
            created.payload.streamId === state.streamId &&
            created.createdAt === state.createdAt;
        }
      } catch (error) {
        this.#invalidCheckpointError ??= error;
      }
      const belongsToThisLog =
        creationMatches &&
        state.eventCount > 0 &&
        state.projectId === this.name.projectId &&
        state.path === this.name.path &&
        state.maxOffset > 0 &&
        state.maxOffset <= this.#log.highestAssignedOffset();
      if (belongsToThisLog) return state;
      this.#invalidCheckpointError ??= new Error(
        `core-state rebuild checkpoint does not describe ${this.name.path}'s current event log`,
      );
    } else {
      this.#invalidCheckpointError ??= parsed.error;
    }
    this.#deleteCoreStateRebuildCheckpoint();
    return undefined;
  }

  #deleteCoreStateRebuildCheckpoint(): void {
    if (this.ctx.storage.kv.get(CORE_STATE_REBUILD_KEY) === undefined) return;
    this.ctx.storage.kv.delete(CORE_STATE_REBUILD_KEY);
  }

  // ===========================================================================
  // Connections: the public live event-callback surface.
  // ===========================================================================

  /**
   * Opens a session-owned callback connection for catch-up and live batches.
   *
   * Synchronous because it mutates the in-memory connection table and returns
   * the live handle for the current Durable Object incarnation; cross-RPC
   * callers still observe an async call through their stub.
   *
   * `openConnection({ connectionKey: "s", processEventBatch })` receives new events by
   * default. `replayAfterOffset: 0` replays durable events from the first row;
   * `3` starts durable replay at offset 4. Ephemeral rows are delivered only
   * if appended after this exact connection opens and are never replayed.
   * Opening the same key again replaces the old connection. Omit
   * `connectionKey` to let the stream assign a random key. Call `close()` on
   * the returned handle to stop delivery.
   *
   * Every batch carries the stream's core reduced `state` as of
   * `streamMaxOffset`, and every connection — with or without replay —
   * immediately receives one batch on open so its callback can paint a first
   * render without a separate getState call. Pass `events: false` for a
   * state-only connection: same batches, `events` always `[]`, consecutive
   * appends coalesced into one state delivery.
   *
   * This method opens session-scoped connections only: they are forgotten on
   * disconnect and callback results are not pulled back over the wire.
   * Durable subscriptions are stored configuration
   * (`subscription-configured` events); the source stream wakes a hosted
   * processor and retains the `processEventBatch` callback it returns.
   */
  openConnection(
    // `wakeSocketId` is internal relay plumbing (which wake socket this open
    // binds), never part of the public Stream contract — the fronting
    // relay generates it and public callers cannot reach this DO directly.
    args: Parameters<Stream["openConnection"]>[0] & { wakeSocketId?: string },
  ): StreamConnectionHandle {
    const connectionKey = args.connectionKey?.trim() || crypto.randomUUID();
    if (this.#coreProcessorState.subscriptions.outbound.byKey[connectionKey] !== undefined) {
      throw new Error(`connectionKey "${connectionKey}" is reserved by a subscription`);
    }
    if (
      args.replayAfterOffset !== undefined &&
      (!Number.isSafeInteger(args.replayAfterOffset) || args.replayAfterOffset < 0)
    ) {
      // NaN binds as SQL NULL downstream (`offset > NULL` matches nothing), so
      // an unvalidated cursor produces a live-looking connection that
      // silently delivers nothing forever.
      throw new Error(`replayAfterOffset must be a non-negative integer`);
    }
    if (
      args.expectedStreamId !== undefined &&
      args.expectedStreamId !== null &&
      args.expectedStreamId.trim().length === 0
    ) {
      throw new Error(`expectedStreamId must be null or a non-empty string`);
    }
    if (
      args.maxReplayOffsetGap !== undefined &&
      (!Number.isSafeInteger(args.maxReplayOffsetGap) || args.maxReplayOffsetGap < 0)
    ) {
      throw new Error(`maxReplayOffsetGap must be a non-negative integer`);
    }
    if (
      args.maxDeliveryEvents !== undefined &&
      (!Number.isSafeInteger(args.maxDeliveryEvents) || args.maxDeliveryEvents < 1)
    ) {
      throw new Error(`maxDeliveryEvents must be a positive integer`);
    }
    if (
      args.maxDeliveryBytes !== undefined &&
      (!Number.isSafeInteger(args.maxDeliveryBytes) || args.maxDeliveryBytes < 1)
    ) {
      throw new Error(`maxDeliveryBytes must be a positive integer`);
    }
    if (args.state === false && args.events === false) {
      throw new Error(`a state-only connection cannot also omit state`);
    }

    // Validate the caller-supplied descriptor at the boundary. The public
    // `Stream.openConnection` contract types `openedBy` as `unknown`, so without
    // this check a malformed descriptor would only fail later, deep inside the
    // reducer, while appending the `connection-opened` presence event. The open
    // path appends that event before publishing the callback, but validating at
    // this boundary still gives the caller the direct descriptor error instead
    // of a deep core-contract failure.
    // The live `getRuntimeState` capability rides as a SIBLING argument (the
    // same position the processor wake response gives it), never inside the descriptor.
    const openedBy =
      args.openedBy === undefined
        ? undefined
        : ConnectionOpenerDescriptorSchema.parse(args.openedBy);

    // One filter shape everywhere: `eventTypes` is sugar for the filter's
    // type list (compileEventFilter also validates any condition upfront).
    const filterSpec: EventFilter = {
      ...args.filter,
      ...(args.eventTypes === undefined ? {} : { eventTypes: [...args.eventTypes] }),
    };
    const filter = compileEventFilter(filterSpec);

    const connection = this.#eventSender.connections.openSession({
      connectionKey,
      processEventBatch: args.processEventBatch,
      replayAfterOffset: args.replayAfterOffset,
      expectedStreamId: args.expectedStreamId,
      maxReplayOffsetGap: args.maxReplayOffsetGap,
      filter,
      events: args.events,
      maxDeliveryEvents: args.maxDeliveryEvents,
      maxDeliveryBytes: args.maxDeliveryBytes,
      includeState: args.state !== false,
      openedBy,
      getRuntimeState: args.getRuntimeState,
      ping: args.ping,
    });

    // Bind this connection's own wake socket (dialed by its relay just before
    // this call, or surviving a DO eviction): store the raw filter spec so a
    // dormant-period append can be matched without a live connection, and
    // clear any dormancy state from an earlier idle close. Every OTHER socket
    // under this connectionKey belongs to a replaced relay — close it so that
    // relay breaks (today's last-writer-wins) instead of lingering dormant
    // and wake-fighting the winner (see WakeSocketUpgradeHeader.socketId).
    for (const { ws, attachment } of this.#wakeSockets(connectionKey)) {
      if (attachment.socketId !== args.wakeSocketId) {
        try {
          ws.close(1000, "superseded");
        } catch {
          // Already closing.
        }
        continue;
      }
      ws.serializeAttachment({
        v: 1,
        connectionKey,
        socketId: attachment.socketId,
        ...(Object.keys(filterSpec).length === 0 ? {} : { filter: filterSpec }),
        ...(args.events === false ? { events: false as const } : {}),
      } satisfies WakeSocketAttachment);
    }

    return new StreamConnectionRpcTarget({
      close: () => connection.close("closed-by-owner"),
      isLive: () => connection.isLive(),
      connectionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
    });
  }

  /**
   * One-shot convenience over `openConnection()`: replay durable events from the
   * requested cursor, then receive newly appended events until a caller predicate accepts one.
   *
   * Rides a session connection, so it CAN match a transient event
   * appended after this wait opens. It never matches a historical ephemeral
   * row, regardless of `afterOffset`.
   *
   * Intentionally not a durable waiter. If the RPC caller or this DO
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
      (!Number.isSafeInteger(args.afterOffset) || args.afterOffset < 0)
    ) {
      throw new Error("waitForEvent afterOffset must be a non-negative safe integer.");
    }

    const predicate = args.predicate ?? (() => true);
    const found = Promise.withResolvers<StreamEvent>();

    // Bound the memory a long wait on a busy stream can hold: keep a count and a
    // small ring of recent types for the timeout message rather than every seen
    // event (events can be multi-megabyte).
    let seenCount = 0;
    const recentTypes: string[] = [];
    let settled = false;

    // Scan delivered batches in order. Predicate work is chained instead of run
    // inline so an async predicate never blocks stream delivery, and a later
    // batch can never overtake an earlier one. The first match wins; a predicate
    // that throws rejects the wait.
    let scan: Promise<void> = Promise.resolve();
    const handle = this.openConnection({
      eventTypes: args.eventTypes,
      replayAfterOffset: args.afterOffset,
      openedBy: { description: "waitForEvent" },
      processEventBatch: ({ events }) => {
        scan = scan.then(async () => {
          for (const event of events) {
            if (settled) break;
            seenCount += 1;
            recentTypes.push(event.type);
            if (recentTypes.length > 20) recentTypes.shift();
            if (await predicate(event)) {
              settled = true;
              found.resolve(event);
              break;
            }
          }
        });
        void scan.catch((error: unknown) => {
          if (settled) return;
          settled = true;
          found.reject(error);
        });
      },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      found.reject(
        new Error(
          `${STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX}Timed out waiting for stream event after ${args.timeoutMs}ms ` +
            `(saw ${seenCount} events; recent types: ${recentTypes.join(", ") || "none"}).`,
        ),
      );
    }, args.timeoutMs);

    try {
      return await found.promise;
    } finally {
      clearTimeout(timer);
      handle.close();
    }
  }

  getProcessorRuntimeState(args: {
    subscriptionKey: string;
  }): Promise<ProcessorRuntimeState | null> {
    return this.#eventSender.connections.getProcessorRuntimeState(args.subscriptionKey);
  }

  runtimeState(): StreamRuntimeDebugState {
    // Observer-driven RTT sampling: being asked for runtime state IS the
    // signal someone is watching. The round runs in the background (this
    // method is synchronous); a later read or live update carries the sample.
    this.#eventSender.connections.samplePingsSoon();
    return this.#readRuntimeState();
  }

  /** Push-driven twin of `runtimeState()` for polling-free debug surfaces. */
  get liveState(): LiveStateRpcTarget<StreamRuntimeDebugState> {
    return new LiveStateRpcTarget({
      live: this.#liveState,
      loadAndRefreshLive: () => {
        this.#eventSender.connections.samplePingsSoon();
        this.#liveState.setState(this.#readRuntimeState());
      },
    });
  }

  /** Materialize at most once per mutation burst, and only while observed. */
  #refreshLiveState(): void {
    // Cursor cleanup can reach this before the constructor assigns
    // #liveState; the optional read is therefore intentional.
    const liveState = this.#liveState;
    if (liveState?.observed !== true || this.#liveStateRefreshScheduled) return;
    this.#liveStateRefreshScheduled = true;
    queueMicrotask(() => {
      this.#liveStateRefreshScheduled = false;
      if (liveState.observed) liveState.setState(this.#readRuntimeState());
    });
  }

  #readRuntimeState(): StreamRuntimeDebugState {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.#eventSender.connections.runtimeState(),
        subscriptions: this.#eventSender.subscriptionRuntimeState(),
        metrics: this.#metrics.report(Date.now()),
        storageSizeBytes: this.ctx.storage.sql.databaseSize,
      },
    };
  }

  // ===========================================================================
  // Wake sockets: the hibernatable channel behind idle-closed session
  // connections (protocol in wake-socket.ts).
  // ===========================================================================

  /**
   * The Stream DO's only fetch surface: the wake-socket upgrade, dialed by
   * `StreamRpcTarget.openConnection`'s relay through this DO's stub (a 101
   * response cannot cross an RPC method call, so this rides a real `fetch()`).
   * Unreachable from external requests — no ingress lane routes fetches to
   * Stream DOs — and additionally gated on the internal header. Sockets are
   * accepted with the Hibernation API so a dormant subscriber costs no
   * duration while it waits.
   */
  async fetch(request: Request): Promise<Response> {
    const wakeHeader = request.headers.get(STREAM_WAKE_SOCKET_HEADER);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || wakeHeader === null) {
      return Response.json(
        { error: "stream durable objects accept only wake-socket upgrades" },
        { status: 400 },
      );
    }
    let binding: z.infer<typeof WakeSocketUpgradeHeader>;
    try {
      binding = WakeSocketUpgradeHeader.parse(JSON.parse(wakeHeader));
    } catch (error) {
      return Response.json(
        {
          error: `invalid ${STREAM_WAKE_SOCKET_HEADER} header: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 400 },
      );
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [WAKE_SOCKET_TAG]);
    pair[1].serializeAttachment({
      v: 1,
      connectionKey: binding.connectionKey,
      socketId: binding.socketId,
    } satisfies WakeSocketAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Wake sockets are one-way (this DO → relay); inbound frames are ignored. */
  webSocketMessage(): void {}

  /**
   * A closed socket disappears from `getWebSockets`, which IS the cleanup:
   * `hasWakeChannel` stops reporting it and the connection (if any) keeps
   * today's non-idle-eligible session semantics.
   */
  webSocketClose(): void {}

  webSocketError(): void {}

  /** Live wake sockets with a valid attachment, optionally for one connectionKey. */
  #wakeSockets(connectionKey?: string): { ws: WebSocket; attachment: WakeSocketAttachment }[] {
    const sockets: { ws: WebSocket; attachment: WakeSocketAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets(WAKE_SOCKET_TAG)) {
      let raw: unknown;
      try {
        raw = ws.deserializeAttachment();
      } catch {
        continue;
      }
      const parsed = WakeSocketAttachment.safeParse(raw);
      if (!parsed.success) continue;
      if (connectionKey !== undefined && parsed.data.connectionKey !== connectionKey) continue;
      sockets.push({ ws, attachment: parsed.data });
    }
    return sockets;
  }

  /**
   * Post-commit twin of `sendDue` for dormant session subscribers: an append
   * necessarily runs inside this DO, so the DO is awake exactly when there is
   * news — no alarm is needed. At most one wake frame per dormancy period
   * (`wakeSentAtOffset`; cleared when the relay's re-dial re-binds the key),
   * and never for the stream's own lifecycle facts or ephemeral rows — a
   * re-dialed connection cannot replay ephemeral history, and waking on
   * lifecycle facts is the resurrection loop wake-socket.ts documents.
   */
  #wakeDormantSessionSubscribers(
    justCommittedEvents?: { event: StreamEvent; byteLength: number }[],
  ): void {
    if (justCommittedEvents === undefined || justCommittedEvents.length === 0) return;
    // Idle teardown's own close-fact appends reconcile through here BEFORE
    // recordSessionIdleClosed stamps the sockets, so a just-closed connection
    // looks unstamped-and-absent — wake-eligible — and a filter that names
    // connection-closed would be woken by its own close, re-dial, and cycle
    // forever. Same guard as the hosted path's sendDue short-circuit; the
    // post-teardown stamp then covers these offsets.
    if (this.#eventSender.connections.isTearingDown) return;
    const sockets = this.#wakeSockets();
    if (sockets.length === 0) return;
    const news = justCommittedEvents
      .map((entry) => entry.event)
      .filter((event) => event.ephemeral !== true);
    if (news.length === 0) return;

    for (const { ws, attachment } of sockets) {
      if (attachment.wakeSentAtOffset !== undefined) continue;
      if (this.#eventSender.connections.has(attachment.connectionKey)) continue;
      // A stamped attachment is ordinary dormancy (idle teardown). An
      // UNSTAMPED socket whose connection is absent means the RPC leg died
      // without the idle protocol — DO eviction mid-live, a delivery-failure
      // close — so its cursor is unknown: any qualifying news wakes it, and
      // the relay re-dials from its own exact cursor. That makes the wake
      // path double as eviction recovery for session subscribers.
      const idleDeliveredThrough = attachment.idleDeliveredThrough;
      const explicitTypes = attachment.filter?.eventTypes;
      const matched = news.some((event) => {
        if (idleDeliveredThrough !== undefined && event.offset <= idleDeliveredThrough) {
          return false;
        }
        // Lifecycle facts wake only a subscriber whose filter names them.
        if (
          WAKE_EXCLUDED_EVENT_TYPES.has(event.type) &&
          explicitTypes?.includes(event.type) !== true
        ) {
          return false;
        }
        // A state-only connection wants any state change; a filterless one wants everything.
        if (attachment.events === false || attachment.filter === undefined) return true;
        try {
          return compileEventFilter(attachment.filter).matches(event);
        } catch {
          // A condition that throws at match time is the delivery side's
          // policy decision; wake the subscriber and let delivery decide.
          return true;
        }
      });
      if (!matched) continue;
      try {
        ws.send(JSON.stringify({ type: "wake" }));
      } catch (error) {
        console.warn("stream wake frame send failed", {
          connectionKey: attachment.connectionKey,
          error,
        });
        continue;
      }
      ws.serializeAttachment({
        ...attachment,
        wakeSentAtOffset: this.#coreProcessorState.maxOffset,
      } satisfies WakeSocketAttachment);
    }
  }

  // ===========================================================================
  // Operator/admin verbs.
  // ===========================================================================

  /** Sever every idle durable connection now — the idle timer's action, exposed for tests/operators. */
  runIdleTeardownNow(): void {
    this.#eventSender.runIdleTeardownNow();
    // A stream going quiet checkpoints before it hibernates, so the next wake
    // rebuilds from a fresh checkpoint instead of folding the debounce window.
    this.#flushCoreProcessorState();
  }

  /** Kills the current Durable Object incarnation so experiments can observe restart behavior. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  /**
   * Wipe this stream's durable storage and abort the current incarnation.
   * The next request creates the stream again with new `created` and `woken` events.
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    this.kill();
  }
}

/** Idempotency deduplicates one logical event, not arbitrary writes sharing a
 * key. `source.copiedFrom` is deliberately excluded: a processor may retry
 * the same logical output after a deploy changes its source-version stamp. */

/**
 * What `append` accepts over the wire: a public event input plus the optional
 * `offset` optimistic-concurrency assertion (split off before validation).
 */
// Built ONCE: constructing a zod schema per appended event cost ~20µs/event
// inside the synchronous commit turn (~50x the hoisted parse).
const StreamAppendInput = StreamEventInputSchema.extend({
  offset: z.number().int().nonnegative().optional(),
}).strict();

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name) {
    throw new Error("Stream Durable Object must be addressed by name.");
  }
  return DurableObjectNameCodec.parse(name, { allowNullProjectId: true });
}

/** How long a stream may hold idle configured delivery connections before severing them. */
function idleTeardownMs(env: Env): number {
  const raw = (env as { STREAM_IDLE_TEARDOWN_MS?: string | number }).STREAM_IDLE_TEARDOWN_MS;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
}
