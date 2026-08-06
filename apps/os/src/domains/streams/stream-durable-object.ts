import { DurableObject, RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import type {
  ProcessorRuntimeState,
  ProcessorSnapshot,
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
import type { LiveStateRpc, LiveStateSubscriptionHandle, LiveUpdate } from "iterate/sdk/capnweb";
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
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { sameCapabilityPath } from "../capability-host/capability-path.ts";
import {
  CAPABILITY_PROVIDER_PAGER_HEADER,
  CAPABILITY_PROVIDER_PAGER_TAG,
  CapabilityProviderPagers,
  type CapabilityProviderCallLegRpcTarget,
  type CapabilityProviderPagerActivation,
} from "../capability-host/capability-provider-pager.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  RevokeCapabilityInput,
} from "../capability-host/types.ts";
import {
  LiveStatePagers,
  liveStatePagerLaneKey,
  liveStatePagerLaneTag,
  parseLiveStatePagerLaneTag,
} from "../live-state-pager.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import { buildCopyAppends } from "./copy-appends.ts";
import {
  assertCoreProcessorCheckpointGrowthFits,
  STREAM_PAUSED_ERROR_PREFIX,
  StreamCoreProcessor,
} from "./core-processor.ts";
import { compileEventFilter, type EventFilter } from "./event-filter.ts";
import { EphemeralEventBuffer } from "./ephemeral-event-buffer.ts";
import { StreamSubscriberPagerRegistry } from "./stream-subscriber-pager.ts";
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
  type SizedStreamEvent,
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
  subscriptionNameForConfiguredEvent,
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
  deleteAlarm(): Promise<void>;
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

  /**
   * Delete the pending native alarm because the caller proved nothing needs
   * a future turn. Safe by construction: durable obligations are visible to
   * that recomputation (cursor rows, in-flight sets, the idle deadline), and
   * new work only arises through an append or wake — both of which reconcile
   * and re-arm. Without this, the in-flight watchdog armed before every
   * successful send outlives its delivery, fires on the hibernated stream,
   * boots it, appends `woken`, whose delivery arms the next watchdog — a
   * perpetual ~21-second boot loop on quiet streams with subscriptions.
   * A later armNoLaterThan in the same turn simply re-arms after the delete.
   */
  clearWhenQuiet(): void {
    this.#armedForMs = null;
    // Same posture as setAlarm: not awaited or caught; the output gate owns it.
    void this.#storage.deleteAlarm();
  }
}

export class StreamDeliveryAlarmBoundary {
  readonly #hooks: StreamDeliveryAlarmBoundaryHooks;
  #inAlarmTurn = false;

  constructor(hooks: StreamDeliveryAlarmBoundaryHooks) {
    this.#hooks = hooks;
  }

  /**
   * True between an append turn arming its immediate work alarm and the
   * alarm turn that runs the re-derived work. In that gap NOTHING else
   * betrays that a wake is owed — no cursor row is due yet, no in-flight
   * flag is set (the closure never started) — so the quiet-alarm deletion
   * must treat this as pending work or it deletes the very alarm that was
   * just armed to start delivery, stranding every durable send.
   */
  #scheduledWorkPending = false;

  get hasScheduledWork(): boolean {
    return this.#scheduledWorkPending;
  }

  scheduleOrRun(work: () => Promise<unknown>): void {
    if (this.#inAlarmTurn) {
      this.#hooks.waitUntil(settleStreamCoreBackgroundWork(work));
      return;
    }
    // setAlarm is itself an output-gated storage write. Issue it directly in
    // this append turn: wrapping it in a settling waitUntil would cross the
    // implicit-transaction boundary and could acknowledge lag without a wake.
    this.#scheduledWorkPending = true;
    this.#hooks.armAlarm(this.#hooks.now());
  }

  runAlarmTurn(work: () => void): void {
    const wasInAlarmTurn = this.#inAlarmTurn;
    this.#inAlarmTurn = true;
    // The fired alarm turn re-derives ALL owed work from durable cursors
    // (the scheduled closure was deliberately discarded), so the owed-wake
    // marker is satisfied the moment this turn starts.
    this.#scheduledWorkPending = false;
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

/**
 * The parent-side view of one processor facet: created via
 * `ctx.facets.get(name, …)` from the `ProcessorFacet` class in
 * `iterate/processors/cloudflare`. Typed loosely at this seam — facet stubs
 * are Fetchers whose RPC surface the facet class defines
 * (configure/wakeStreamProcessor/handleAlarm, plus read doors phase 2 dials).
 */
type ProcessorFacetStub = {
  configure(identity: {
    parentName: string;
    projectId: string | null;
    path: string;
  }): Promise<unknown>;
  wakeStreamProcessor(request: StreamProcessorWakeRequest): Promise<unknown>;
  handleAlarm(info?: AlarmInvocationInfo): Promise<unknown>;
  // Read doors on the base ProcessorFacet class plus the OS subclass's own
  // (catchUp, the capability-host domain doors, the slack presentation push)
  // — dispatched through the parent's per-subscription facade below.
  catchUp(args: { name: string }): Promise<void>;
  snapshot(args?: { name?: string }): Promise<ProcessorSnapshot<unknown>>;
  getRuntimeState(args?: { name?: string }): Promise<ProcessorRuntimeState>;
  waitUntilProcessed(args: { offset: number; timeoutMs?: number; name?: string }): Promise<void>;
  liveState(): Promise<LiveStateRpc<Record<string, unknown>>>;
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  provideCapability(
    input: CapabilityProvidedPayload,
    options?: { afterAppend?(record: CapabilityRecord): void | Promise<void> },
  ): Promise<{ path: string[]; providedAtOffset: number }>;
  revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void>;
  describeCapabilities(): Promise<unknown[]>;
  connectCapabilityProviderPager(options: {
    afterAppend(connectedAtOffset: number): void | Promise<void>;
  }): Promise<number>;
  disconnectCapabilityProviderPager(args: { connectedAtOffset: number }): Promise<void>;
  setPreamble(input: { code: string; key: string }): Promise<void>;
  removePreamble(input: { key: string }): Promise<void>;
  describePreamble(): Promise<{ text: string; entries: { key: string; code: string }[] } | null>;
  getScriptResult(executionId: string): Promise<{ executionId: string; data: unknown }>;
  presentAgentRuntimeTransition(args: { transition: unknown }): Promise<unknown>;
};

/**
 * The slice of the capability-host fold the parent-held Capability Provider
 * Pager wiring reads: the mount table plus the connected-Pager references —
 * enough to gate live provisions, retire displaced mounts, and reconcile
 * Pagers that did not survive a restart.
 */
type CapabilityHostFacetState = {
  capabilities: CapabilityRecord[];
  capabilityProviderPagers: { connectedAtOffset: number }[];
};

/**
 * The parent-side capability doors {@link StreamProcessorFacadeRpcTarget}
 * routes through for THIS stream's capability-host facet, so live-mount
 * bookkeeping and the control-plane serialization stay coupled to the
 * parent-held Pager sockets — exactly as the retired
 * CapabilityHostDurableObject coupled them in one class.
 */
type CapabilityHostFacadeWiring = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  provideCapability(
    input: CapabilityProvidedPayload,
  ): Promise<{ path: string[]; providedAtOffset: number }>;
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
  describeCapabilities(): Promise<unknown[]>;
  setPreamble(input: { code: string; key: string }): Promise<void>;
  removePreamble(input: { key: string }): Promise<void>;
};

/** Build the concrete calls used by the receiver union. */
function createSubscriptionReceiverCalls(deps: {
  projectId: string | null;
  exports: unknown;
  createAuthorityRoot(): unknown;
  /** Dial (create/configure if needed) the processor facet named after the subscription. */
  dialProcessorFacet(name: string): Promise<ProcessorFacetStub>;
  copyToStream(path: string, batch: StreamDeliveryBatch): Promise<CopyReceipt>;
  onHostedDeliveryError(
    name: string,
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
    async wakeStreamProcessor(receiver, request, expectedDelivery) {
      let value: unknown;
      if (receiver.placement === "facet") {
        // Facet placement: the subscription name IS the facet name; the wake
        // is an in-process parent→facet dial, no itx expression involved. The
        // facet's wakeStreamProcessor returns the standard wake response, so
        // everything downstream (retention, batching, watchdog) is shared.
        const facet = await deps.dialProcessorFacet(request.name);
        value = await facet.wakeStreamProcessor(request);
      } else {
        if (receiver.expression === undefined) {
          throw new Error(
            `processor-wake subscription "${request.name}" has neither facet placement nor an expression`,
          );
        }
        ({ value } = await evaluateItxExpression(
          deps.createAuthorityRoot(),
          toInvocation(receiver.expression, request),
        ));
      }
      return retainProcessorWakeResponse({
        value,
        onDeliveryError: (error) =>
          deps.onHostedDeliveryError(request.name, error, expectedDelivery),
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
        // The 2xx alone is the whole acknowledgement; the body is discarded
        // unread. (An offset-acking webhook that owns its durable position
        // through the response body is future work — see
        // docs/stream-subscription-model-redesign.md.)
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
 * The subscription name of the worker feed every project-scoped stream uses.
 * Child streams configure it at birth. The project creation saga configures
 * it on `/` only after the seeded default worker has built.
 */
const PROJECT_WORKER_SUBSCRIPTION_NAME = "project-worker";

/**
 * The facet slice's one shared alarm desire (wall-clock ms), in the parent's
 * kv. Facets cannot own a platform alarm (structural in workerd), so every
 * facet's `proxySetAlarm` merges into this single slot — kept at the EARLIEST
 * requested time, because the proxy verbs carry no facet identity and an early
 * fire is safe (each replayed `handleAlarm` is level-triggered and re-arms its
 * own remaining desire) while a lost fire is not. A fire clears the slot and
 * replays into every facet-placed subscription's facet.
 */
const FACET_ALARM_KV_KEY = "facetAlarmAtMs";

/** Bounded extra delay before retrying a facet's failed alarm replay. */
const FACET_ALARM_RETRY_DELAY_MS = 1_000;

/**
 * One row of `subscriptions.list()`: the committed catalog entry joined with
 * its durable cursor — name, receiver kind, status, and lag
 * (head − confirmed).
 */
export type StreamSubscriptionListEntry = {
  name: string;
  action: string;
  placement?: "facet";
  configuredAtOffset: number;
  status: "active" | "halted";
  lag: number;
  confirmedOffset: number;
  lastError: string | null;
};

/** `subscriptions.get(name).describe()`: the committed configuration plus the
 * durable confirmed cursor and retry state. */
export type StreamSubscriptionDescription = {
  name: string;
  configuration: unknown;
  configuredAtOffset: number;
  status: "active" | "halted";
  lag: number;
  confirmedOffset: number;
  attempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

/**
 * The Stream DO's per-subscription processor facade: the read/domain surface
 * of ONE facet-hosted processor instance, addressed by its subscription name
 * (`processorFacade(name)` below). This is what the itx relays dial instead
 * of the retired hosting Durable Objects — `agent.processor.snapshot()`,
 * `capabilityHost.invokeCapability(...)`, `secret.liveState`, … all resolve
 * through here. Every method dials the facet fresh (facet stubs are cheap
 * parent-side handles) and forwards; the facet's registry resolves the named
 * runner.
 */
class StreamProcessorFacadeRpcTarget extends RpcTarget {
  readonly #name: string;
  readonly #dial: () => Promise<ProcessorFacetStub>;
  readonly #capabilityHost: CapabilityHostFacadeWiring | undefined;

  constructor(input: {
    name: string;
    dial: () => Promise<ProcessorFacetStub>;
    /** Present only on the capability-host facade: routes the capability
     * doors through the parent's Pager wiring instead of straight to the facet. */
    capabilityHost?: CapabilityHostFacadeWiring;
  }) {
    super();
    this.#name = input.name;
    this.#dial = input.dial;
    this.#capabilityHost = input.capabilityHost;
  }

  /** One consistent read of the committed fold, after a pull through the
   * durable stream tail (read-your-writes — the retired hosts'
   * catchUpBeforeSnapshot leg). */
  async snapshot(): Promise<ProcessorSnapshot<unknown>> {
    const facet = await this.#dial();
    await facet.catchUp({ name: this.#name });
    return await facet.snapshot({ name: this.#name });
  }

  async getRuntimeState(): Promise<ProcessorRuntimeState> {
    const facet = await this.#dial();
    return await facet.getRuntimeState({ name: this.#name });
  }

  /** Offset barrier against the named runner's confirmed fold (self-pulling). */
  async waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    const facet = await this.#dial();
    await facet.waitUntilProcessed({ ...input, name: this.#name });
  }

  /**
   * Facet placement means the STREAM wakes the processor itself (an
   * in-process parent→facet dial) — nothing may push batches in through the
   * public facade, and the wake response's facet-side capabilities could not
   * cross this boundary anyway (facet stubs never leave the parent).
   */
  wakeStreamProcessor(): never {
    throw new Error(
      `subscription "${this.#name}" runs under facet placement: its stream delivers wakes ` +
        `directly; wakeStreamProcessor is not dialable through the processor facade`,
    );
  }

  /** The instance's live-state node: snapshot + minimal diffs, re-wrapped —
   * the facet returns plain capability functions, and the subscriber's
   * callback flows INTO the facet as an ordinary argument capability. */
  get liveState(): LiveStateRpc<Record<string, unknown>> {
    return new FacetLiveStateRelayRpcTarget(async () => (await this.#dial()).liveState());
  }

  // Capability-host domain doors (the retired CapabilityHostDurableObject's
  // forwarded methods). They are only ever dialed on the "capability-host"
  // facade, which processorFacade always builds with the parent wiring, so
  // reconciliation, live-mount retirement, and the control-plane serialization
  // all engage. #requireCapabilityHost enforces that invariant.
  #requireCapabilityHost(): CapabilityHostFacadeWiring {
    if (this.#capabilityHost === undefined) {
      throw new Error("capability door dialed on a facade without capability-host wiring");
    }
    return this.#capabilityHost;
  }

  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return await this.#requireCapabilityHost().invokeCapability(input);
  }

  async provideCapability(
    input: CapabilityProvidedPayload,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    return await this.#requireCapabilityHost().provideCapability(input);
  }

  async revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    await this.#requireCapabilityHost().revokeCapability(input);
  }

  async describeCapabilities(): Promise<unknown[]> {
    return await this.#requireCapabilityHost().describeCapabilities();
  }

  // Preamble mutations ride the parent's capability serialization (a set-time
  // compile snapshots state, awaits an expensive check, then appends, so two
  // concurrent sets validating against the same snapshot could otherwise
  // commit a preamble that no longer compiles). The reads below forward plainly.
  async setPreamble(input: { code: string; key: string }): Promise<void> {
    await this.#requireCapabilityHost().setPreamble(input);
  }

  async removePreamble(input: { key: string }): Promise<void> {
    await this.#requireCapabilityHost().removePreamble(input);
  }

  async describePreamble(): Promise<{
    text: string;
    entries: { key: string; code: string }[];
  } | null> {
    return await (await this.#dial()).describePreamble();
  }

  async getScriptResult(executionId: string): Promise<{ executionId: string; data: unknown }> {
    return await (await this.#dial()).getScriptResult(executionId);
  }
}

/**
 * Parent-side re-wrap of a facet's live-state node. The facet hop is Workers
 * RPC, which cannot serialize capnweb RpcTargets, so the facet answers with
 * PLAIN objects of capability functions ({@link LiveStateRpc} shape) and this
 * relay is the real RpcTarget the outside world holds. Subscription handles
 * are re-wrapped the same way — a facet-side stub must never leave the parent.
 */
class FacetLiveStateRelayRpcTarget
  extends RpcTarget
  implements LiveStateRpc<Record<string, unknown>>
{
  readonly #dialLive: () => Promise<LiveStateRpc<Record<string, unknown>>>;

  constructor(dialLive: () => Promise<LiveStateRpc<Record<string, unknown>>>) {
    super();
    this.#dialLive = dialLive;
  }

  async get(): Promise<Record<string, unknown>> {
    return await (await this.#dialLive()).get();
  }

  async subscribe(
    onUpdate: (update: LiveUpdate<Record<string, unknown>>) => unknown,
  ): Promise<LiveStateSubscriptionHandle> {
    const handle = await (await this.#dialLive()).subscribe(onUpdate);
    return {
      ping: () => handle.ping(),
      unsubscribe: () => handle.unsubscribe(),
      [Symbol.dispose]: () => handle.unsubscribe(),
    };
  }
}

/** The committed receiver union as stored in reduced core state. */
type OutboundSubscriptionReceiver =
  CoreProcessorState["subscriptions"]["outbound"]["byName"][string]["configuration"]["receiver"];

/** The processor-wake variant of {@link OutboundSubscriptionReceiver}. */
type ProcessorWakeReceiver = Extract<OutboundSubscriptionReceiver, { action: "processor-wake" }>;

/**
 * Copy an expression-evaluation result into plain data and release the
 * original. The worker's processor node answers with plain JSON, but the
 * value reaching this DO may be a disposable-augmented RPC result whose
 * lifetime must not leak into the caller's Cap'n Web session.
 */
function detachExpressionReadResult<T>(value: unknown, operation: string): T {
  if (value === null || typeof value !== "object") return value as T;
  const detached: unknown = Array.isArray(value) ? [...value] : { ...value };
  Reflect.deleteProperty(detached as object, Symbol.dispose);
  disposeAcknowledgedRpcResult(value, operation);
  return detached as T;
}

/**
 * The subscriptions catalog's processor facade for an EXPRESSION-placed
 * subscription (own-DO first-party hosts and userspace dynamic workers). The
 * read verbs replay onto the worker's `processor` node — the stored wake
 * expression minus its trailing `wakeStreamProcessor` step — with the same
 * delivery authority the wake transport uses, so
 * `subscriptions.get(name).processor` serves snapshot / getRuntimeState /
 * waitUntilProcessed for EVERY placement. Facet-only doors (liveState, the
 * capability-host domain doors) reject explicitly: they have no
 * expression-side counterpart, and the wake step stays platform-only.
 */
class ExpressionProcessorFacadeRpcTarget extends RpcTarget {
  readonly #name: string;
  readonly #callProcessorNode: (call: [method: string, ...args: unknown[]]) => Promise<unknown>;
  readonly #waitUntilProcessed: (input: { offset: number; timeoutMs?: number }) => Promise<void>;

  constructor(input: {
    name: string;
    callProcessorNode: (call: [method: string, ...args: unknown[]]) => Promise<unknown>;
    waitUntilProcessed: (input: { offset: number; timeoutMs?: number }) => Promise<void>;
  }) {
    super();
    this.#name = input.name;
    this.#callProcessorNode = input.callProcessorNode;
    this.#waitUntilProcessed = input.waitUntilProcessed;
  }

  async snapshot(): Promise<ProcessorSnapshot<unknown>> {
    return detachExpressionReadResult(
      await this.#callProcessorNode(["snapshot"]),
      "expression-processor-snapshot",
    );
  }

  async getRuntimeState(): Promise<ProcessorRuntimeState> {
    return detachExpressionReadResult(
      await this.#callProcessorNode(["getRuntimeState"]),
      "expression-processor-runtime-state",
    );
  }

  /** Delegates to the stream's uniform barrier, which already swaps the wake
   * step for the processor node's own `waitUntilProcessed` verb. */
  async waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    await this.#waitUntilProcessed(input);
  }

  /** Mirror of the facet facade's guard: wake delivery belongs to the stream. */
  wakeStreamProcessor(): never {
    throw new Error(
      `subscription "${this.#name}" is delivered by its stream; wakeStreamProcessor is not ` +
        `dialable through the processor facade`,
    );
  }

  #facetOnly(door: string): never {
    throw new Error(
      `subscription "${this.#name}" runs under expression placement; ${door} is served by the ` +
        `hosting worker itself, not the subscriptions catalog`,
    );
  }

  /** A getter like the facet facade's node, so the property read itself
   * rejects instead of handing out a dead stub. */
  get liveState(): never {
    return this.#facetOnly("liveState");
  }

  invokeCapability(): never {
    this.#facetOnly("invokeCapability");
  }

  provideCapability(): never {
    this.#facetOnly("provideCapability");
  }

  revokeCapability(): never {
    this.#facetOnly("revokeCapability");
  }

  describeCapabilities(): never {
    this.#facetOnly("describeCapabilities");
  }
}

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
  /** Ephemeral event bodies scoped to this one Durable Object incarnation. */
  readonly #ephemeralEvents = new EphemeralEventBuffer();
  /**
   * Waiters parked on `waitUntilProcessed`'s cursor-row lane, checked from
   * every cursor-store mutation. One-shot and in-memory on purpose: the
   * barrier dies with the RPC caller or this incarnation, exactly like
   * `waitForEvent`.
   */
  readonly #confirmationWaiters = new Set<{ check(): void }>();
  /**
   * Durable subscription cursor rows. A field (not inlined into the hooks)
   * because the core-state rebuild path removes rows whose configuration no
   * longer exists — see #readCoreProcessorState.
   */
  readonly #subscriptionCursorStore = new SqliteSubscriptionCursorStore(this.ctx.storage.sql, {
    onMutation: () => {
      this.#refreshLiveState();
      for (const waiter of this.#confirmationWaiters) waiter.check();
    },
  });
  /** In-memory throughput accounting (events/s, bytes in/out); resets with the incarnation. */
  readonly #metrics = new StreamRuntimeMetrics(Date.now());
  readonly #alarmArmer = new StreamAlarmArmer(this.ctx.storage);
  readonly #deliveryAlarmBoundary = new StreamDeliveryAlarmBoundary({
    armAlarm: (atMs) => this.#alarmArmer.armNoLaterThan(atMs),
    now: () => Date.now(),
    waitUntil: (work) => this.ctx.waitUntil(work),
  });
  readonly #eventSender: StreamEventSender = new StreamEventSender({
    hooks: {
      // Delivery needs byte lengths for its batch cap. This merges durable
      // SQLite rows with the current incarnation's memory-only ephemeral
      // events before subscription-specific visibility is applied.
      readEvents: (args) =>
        this.#readEventsSized({
          afterOffset: args.afterOffset,
          beforeOffset: args.beforeOffset,
          limit: args.limit,
          includeEphemeral: true,
        }),
      coreState: () => this.#coreProcessorState,
      store: this.#subscriptionCursorStore,
      receiverCalls: createSubscriptionReceiverCalls({
        projectId: this.name.projectId,
        exports: this.ctx.exports,
        createAuthorityRoot: () => this.#createEventDeliveryAuthorityRoot(),
        dialProcessorFacet: (name) => this.#dialProcessorFacet(name),
        copyToStream: (path, batch) => this.#streamStub(path).receiveCopiedEvents(batch),
        onHostedDeliveryError: (name, error, expectedDelivery) =>
          this.#eventSender.connections.onHostedDeliveryError(name, error, expectedDelivery),
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
      clearAlarm: () => {
        // An append turn may have armed an immediate alarm for scheduled
        // durable work that has not started yet; that owed wake is invisible
        // to the sender's recomputation and must veto the deletion.
        if (this.#deliveryAlarmBoundary.hasScheduledWork) return;
        this.#alarmArmer.clearWhenQuiet();
      },
      runDurable: (work) => this.#deliveryAlarmBoundary.scheduleOrRun(work),
      keepAlive: (promise) => this.#runInBackground(() => promise),
      subscriberPagerConnectionKeys: () => this.#subscriberPagers.connectionKeys(),
      onSessionsIdleClosed: (connectionKeys) =>
        this.#subscriberPagers.recordIdleClosed(connectionKeys),
      pageDormantSubscribers: (justCommitted) =>
        this.#subscriberPagers.pageDormant(justCommitted.map((entry) => entry.event)),
    },
  });
  /** The client-given Stream Subscriber Pager; its attachment is the durable state. */
  readonly #subscriberPagers = new StreamSubscriberPagerRegistry({
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    maxOffset: () => this.#coreProcessorState.maxOffset,
    hasConnection: (connectionKey) => this.#eventSender.connections.has(connectionKey),
  });
  /** Client-given Capability Provider Pagers for the capability-host FACET.
   * The sockets, retained provider legs, and pending activations are all
   * runtime state, so they live HERE on the parent — the facet keeps only the
   * durable mount facts — mirroring how the facet liveState lanes keep their
   * watcher sockets parent-side. See the Capability Provider Pagers section. */
  readonly #capabilityProviderPagers = new CapabilityProviderPagers({
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
  });
  #capabilityMutationTail = Promise.resolve();
  #capabilityProviderPagerStartup: Promise<void> | undefined;
  /** Client-given Live State Pagers — push-driven runtime debug state at zero pin. */
  readonly #liveStatePagers = new LiveStatePagers({
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    readState: () => this.#readRuntimeState(),
    // Runtime state is always materializable — no runner loading here; the
    // refresh just requests a ping-sample round so a fresh watcher's first
    // frame carries real connection RTTs, mirroring the getter's behavior.
    refresh: () => this.#eventSender.connections.samplePingsSoon(),
    waitUntil: (work) => this.ctx.waitUntil(work),
  });
  /**
   * KEYED liveState lanes, one per facet-hosted processor subscription (lane
   * key = subscription name — the same name `processorFacade` dials). This is
   * how the retired hosting DOs' socket lanes survive the facet move: the
   * worker relay (`facetProcessorLiveStateRelay`) dials THIS Durable Object
   * with the lane key, and the lane pushes that facet's live state. The state
   * is materialized inside the facet, so each lane pushes from a parent-held
   * cache: `refresh` pulls the facet's current projection through its
   * liveState door, and `#refreshLiveState` — which fires on every durable
   * cursor mutation, i.e. after every hosted delivery — triggers
   * `refreshThenFlush`. That is complete change coverage because a facet fold
   * only advances on committed events, and every commit is followed by a
   * parent-driven delivery whose cursor row mutates here. Entries are created
   * on upgrade and rebuilt by #finishInitialization for watcher sockets that
   * hibernated across an eviction.
   */
  readonly #facetLiveStateLanes = new Map<string, LiveStatePagers>();

  #facetLiveStateLane(name: string): LiveStatePagers {
    let lane = this.#facetLiveStateLanes.get(name);
    if (lane === undefined) {
      // The cache the flusher reads (readState must be synchronous — the
      // flusher sends what it read with no await in between). Pulls are
      // chained so a slower OLDER pull can never overwrite a newer one — the
      // wire has no revision guard by design, so cache monotonicity is the
      // whole rewind defense.
      let state: Record<string, unknown> = {};
      let chain: Promise<void> = Promise.resolve();
      const pull = async () => {
        const facet = await this.#dialProcessorFacet(name);
        state = await (await facet.liveState()).get();
      };
      const tag = liveStatePagerLaneTag(name);
      lane = new LiveStatePagers({
        getWebSockets: () => this.ctx.getWebSockets(tag),
        acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws, [tag]),
        readState: () => state,
        refresh: () => {
          // Every refresh gets a FRESH pull that starts after its trigger
          // (sharing an in-flight pull could return state read before the
          // triggering change), serialized behind whatever is in flight.
          const next = chain.then(pull, pull);
          chain = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        },
        waitUntil: (work) => this.ctx.waitUntil(work),
      });
      this.#facetLiveStateLanes.set(name, lane);
    }
    return lane;
  }
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

    // Re-create keyed facet lanes for watcher sockets that hibernated across
    // an eviction: their hibernation tags name the lane, and a lane object
    // must exist for the parent-side triggers in #refreshLiveState to reach
    // them. (The unkeyed runtime lane needs no rebuild — its instance is a
    // field.)
    for (const ws of this.ctx.getWebSockets()) {
      for (const tag of this.ctx.getTags(ws)) {
        const lane = parseLiveStatePagerLaneTag(tag);
        if (lane !== undefined) this.#facetLiveStateLane(lane);
      }
    }

    // Level-triggered boot repair for the facet alarm slice: the native alarm
    // normally survives eviction, but a crash between markFired and the
    // re-arm could otherwise strand a persisted facet desire forever.
    const facetAlarmAtMs = this.#readFacetAlarmAtMs();
    if (facetAlarmAtMs !== null) this.#alarmArmer.armNoLaterThan(facetAlarmAtMs);

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
              name: PROJECT_WORKER_SUBSCRIPTION_NAME,
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
  alarm(alarmInfo?: AlarmInvocationInfo): void {
    this.#alarmArmer.markFired();
    this.#deliveryAlarmBoundary.runAlarmTurn(() => {
      this.#fireDueFacetAlarms(alarmInfo);
      this.#reconcileCommittedState({ alarmTurn: true });
    });
  }

  // ===========================================================================
  // Processor facets: parent→facet dial, and the parent-owned alarm proxy.
  // Facets cannot own a platform alarm (structural in workerd); the Stream DO
  // multiplexes their alarm desires through its own StreamAlarmArmer and
  // replays fires into each facet's handleAlarm.
  // ===========================================================================

  /** Facets configured this incarnation; a redundant configure after eviction is safe. */
  readonly #configuredProcessorFacets = new Set<string>();
  /** Per-facet consecutive handleAlarm replay failures (backoff input; in-memory). */
  readonly #facetAlarmFailures = new Map<string, number>();

  /**
   * The committed catalog row a processor read/dial door may act on: the
   * subscription must EXIST and be a processor-wake row. Reads must never
   * materialize processor state for a caller-chosen name the committed
   * catalog does not place there — `ctx.facets.get` CREATES a facet on first
   * dial, so an unchecked name would mint arbitrary facets (including
   * wrong-path first-party runners) from a read. Same gate shape as
   * `waitUntilProcessed`'s existence check.
   */
  #requireProcessorWakeSubscription(name: string): ProcessorWakeReceiver {
    const configured = this.#coreProcessorState.subscriptions.outbound.byName[name];
    if (configured === undefined) {
      throw new Error(`subscription "${name}" does not exist`);
    }
    const receiver = configured.configuration.receiver;
    if (receiver.action !== "processor-wake") {
      throw new Error(`subscription "${name}" is not a processor-wake subscription`);
    }
    return receiver;
  }

  /**
   * Create-or-reuse the processor facet named after a subscription and make
   * sure it received its first-contact `configure` before any wake. The class
   * is the sibling `ProcessorFacet` export from `iterate/processors/cloudflare`,
   * re-exported as an OS worker entrypoint so `ctx.exports` carries it.
   *
   * THE facet-materialization choke point: every caller funnels through the
   * committed-catalog check, so no read, socket lane, alarm replay, or
   * facade dial can create a facet for a name the catalog does not place
   * under facet placement.
   */
  async #dialProcessorFacet(name: string): Promise<ProcessorFacetStub> {
    const receiver = this.#requireProcessorWakeSubscription(name);
    if (receiver.placement !== "facet") {
      throw new Error(`subscription "${name}" does not run under facet placement`);
    }
    const workerExports = this.ctx.exports as Record<string, unknown>;
    // Loose lookup on purpose: the class is the sibling ProcessorFacet export
    // from iterate/processors/cloudflare, surfaced as an OS worker entrypoint;
    // ctx.exports carries every exported entrypoint by name.
    const facetClass = workerExports.ProcessorFacet as DurableObjectClass | undefined;
    if (facetClass === undefined) {
      throw new Error(
        'facet placement requires the OS worker to export the "ProcessorFacet" entrypoint',
      );
    }
    // Safe: ctx.facets.get returns an untyped Fetcher stub (workerd's facet
    // API carries no class-level typing), but the instance behind it is
    // always the ProcessorFacet class passed in the startup callback above —
    // ProcessorFacetStub is exactly that class's RPC surface.
    const facet = this.ctx.facets.get(name, () => ({
      class: facetClass,
    })) as unknown as ProcessorFacetStub;
    if (!this.#configuredProcessorFacets.has(name)) {
      const parentName = this.ctx.id.name;
      if (parentName === undefined) {
        throw new Error("Stream Durable Object must be addressed by name.");
      }
      await facet.configure({
        parentName,
        projectId: this.name.projectId,
        path: this.name.path,
      });
      this.#configuredProcessorFacets.add(name);
    }
    return facet;
  }

  #readFacetAlarmAtMs(): number | null {
    return this.ctx.storage.kv.get<number>(FACET_ALARM_KV_KEY) ?? null;
  }

  /** Merge a desire into the shared slot at the EARLIEST time and arm the real alarm. */
  #mergeFacetAlarmDesire(atMs: number): void {
    const existing = this.#readFacetAlarmAtMs();
    const merged = existing === null ? atMs : Math.min(existing, atMs);
    this.ctx.storage.kv.put(FACET_ALARM_KV_KEY, merged);
    this.#alarmArmer.armNoLaterThan(merged);
  }

  /**
   * Facet-only alarm door ({@link ProcessorFacetAlarmProxy}'s implementation):
   * a facet's `ctx.storage.setAlarm` lands here. The verbs carry no facet
   * identity, so desires from every facet merge into one earliest-time slot;
   * reentrant calls during an in-flight `handleAlarm` replay are ordinary
   * merges into the same slot.
   */
  proxySetAlarm(scheduledTimeMs: number): void {
    this.#mergeFacetAlarmDesire(z.number().int().nonnegative().parse(scheduledTimeMs));
  }

  /**
   * Facet-only alarm door. Deliberately a no-op on the shared slot: without a
   * facet identity, deleting could lose a SIBLING facet's pending desire, and
   * one spurious fire is harmless — every replayed `handleAlarm` is
   * level-triggered and simply re-arms nothing, after which the slot stays
   * clear.
   */
  proxyDeleteAlarm(): void {}

  /** Facet-only alarm door: the shared slot's currently desired fire time. */
  proxyGetAlarm(): number | null {
    return this.#readFacetAlarmAtMs();
  }

  /**
   * When the shared facet slot is due: clear it BEFORE the replays (a facet
   * reentrantly calling `proxySetAlarm` during the awaited `handleAlarm` lands
   * a fresh desire the completion path never clobbers), then replay the fire
   * into EVERY facet-placed subscription's facet — early fires are safe, and
   * without per-facet identity the fan-out is what makes no desire lose its
   * fire. A failed replay merges a bounded retry back into the slot.
   */
  #fireDueFacetAlarms(alarmInfo?: AlarmInvocationInfo): void {
    const dueAtMs = this.#readFacetAlarmAtMs();
    if (dueAtMs === null) return;
    if (dueAtMs > Date.now()) {
      // A fresh incarnation's armer memory is empty; keep the slot armed.
      this.#alarmArmer.armNoLaterThan(dueAtMs);
      return;
    }
    this.ctx.storage.kv.delete(FACET_ALARM_KV_KEY);
    const facetNames = Object.entries(
      this.#coreProcessorState.subscriptions.outbound.byName,
    ).flatMap(([name, entry]) => {
      const receiver = entry.configuration.receiver;
      return receiver.action === "processor-wake" && receiver.placement === "facet" ? [name] : [];
    });
    // Plain copy: the platform's AlarmInvocationInfo host object does not
    // serialize across the facet hop.
    const info: AlarmInvocationInfo | undefined =
      alarmInfo === undefined
        ? undefined
        : {
            isRetry: alarmInfo.isRetry,
            retryCount: alarmInfo.retryCount,
            scheduledTime: alarmInfo.scheduledTime,
          };
    for (const facet of facetNames) {
      this.#runInBackground(async () => {
        try {
          const stub = await this.#dialProcessorFacet(facet);
          await stub.handleAlarm(info);
          this.#facetAlarmFailures.delete(facet);
        } catch (error) {
          const failures = (this.#facetAlarmFailures.get(facet) ?? 0) + 1;
          this.#facetAlarmFailures.set(facet, failures);
          console.error("facet alarm replay failed; re-arming a bounded retry", {
            facet,
            failures,
            error,
          });
          this.#mergeFacetAlarmDesire(
            Date.now() + computeBackoffMs(failures, Math.random()) + FACET_ALARM_RETRY_DELAY_MS,
          );
        }
      });
    }
  }

  /**
   * The per-subscription processor facade — the read/domain surface itx
   * relays dial for hosted processors (snapshot, runtime state, offset
   * barriers, live state, and the capability-host domain doors), routed by
   * the COMMITTED catalog row: a facet-placed subscription serves its facet
   * (the name IS the facet name), an expression-placed one replays the read
   * verbs onto the worker's `processor` node, and a name the catalog does
   * not know throws — a read must never materialize a facet.
   */
  processorFacade(args: {
    name: string;
  }): StreamProcessorFacadeRpcTarget | ExpressionProcessorFacadeRpcTarget {
    const name = z.string().trim().min(1).parse(args.name);
    const receiver = this.#requireProcessorWakeSubscription(name);
    if (receiver.placement === "facet") {
      return new StreamProcessorFacadeRpcTarget({
        name,
        dial: () => this.#dialProcessorFacet(name),
        // Only the capability-host facade routes its capability doors through
        // the parent-held Capability Provider Pager wiring — that is the one
        // facet whose live mounts have runtime state (sockets, provider legs)
        // living on this parent.
        ...(name === CapabilityHostProcessorContract.slug
          ? { capabilityHost: this.#capabilityHostFacadeWiring() }
          : {}),
      });
    }
    return new ExpressionProcessorFacadeRpcTarget({
      name,
      callProcessorNode: (call) => this.#callExpressionProcessorNode(name, call),
      waitUntilProcessed: (input) => this.waitUntilProcessed(name, input),
    });
  }

  /**
   * Replay one read verb on an EXPRESSION-placed subscription's processor
   * node: the stored wake expression minus its trailing wake step names the
   * worker's `processor` node, and the call runs with the same delivery
   * authority the wake transport uses. The row is re-read per call so a
   * removed or re-placed subscription is honored at call time.
   */
  async #callExpressionProcessorNode(
    name: string,
    call: [method: string, ...args: unknown[]],
  ): Promise<unknown> {
    const receiver = this.#requireProcessorWakeSubscription(name);
    if (receiver.placement === "facet") {
      throw new Error(`subscription "${name}" now runs under facet placement; re-dial its facade`);
    }
    if (receiver.expression === undefined) {
      throw new Error(
        `processor-wake subscription "${name}" has neither facet placement nor an expression`,
      );
    }
    const { value } = await evaluateItxExpression(this.#createEventDeliveryAuthorityRoot(), [
      ...receiver.expression.slice(0, -1),
      call,
    ]);
    return value;
  }

  // ===========================================================================
  // Capability Provider Pagers: the parent-held runtime half of the
  // capability-host FACET's live mounts. A provider client gives THIS Durable
  // Object one hibernatable Pager ("release my RPC references while idle;
  // Page this return channel when a mount of mine is called"); the facet owns
  // the durable facts (connected/provided/disconnected events and their
  // reduction), while the sockets, retained provider legs, and pending
  // activations live here — the same parent-owns-the-socket split as the
  // facet liveState lanes. This section is the retired
  // CapabilityHostDurableObject's wiring with every processor/registry read
  // replaced by a facet dial.
  // ===========================================================================

  /** The capability-host facet behind this stream's capability doors. */
  #dialCapabilityHostFacet(): Promise<ProcessorFacetStub> {
    return this.#dialProcessorFacet(CapabilityHostProcessorContract.slug);
  }

  /** One catch-up-backed read of the capability-host fold. */
  async #capabilityHostState(facet: ProcessorFacetStub): Promise<CapabilityHostFacetState> {
    await facet.catchUp({ name: CapabilityHostProcessorContract.slug });
    const snapshot = await facet.snapshot({ name: CapabilityHostProcessorContract.slug });
    // Safe: every project-scoped facet composition registers the
    // CapabilityHostProcessor under its contract slug, so this snapshot's
    // state is that contract's fold; CapabilityHostFacetState is the narrow
    // slice of it this wiring reads.
    return snapshot.state as CapabilityHostFacetState;
  }

  /**
   * Bind a relay's freshly dialed Pager to its durable connected event. The
   * `pagerDialId` only correlates the WebSocket upgrade with this call — the
   * connected event's offset is the Pager's durable identity from here on.
   */
  async connectCapabilityProviderPager(input: { pagerDialId: string }): Promise<number> {
    await this.#ensureCapabilityProviderPagersReconciled();
    try {
      return await this.#serializeCapabilityMutation(async () => {
        const facet = await this.#dialCapabilityHostFacet();
        return await facet.connectCapabilityProviderPager({
          afterAppend: (connectedAtOffset) => {
            if (!this.#capabilityProviderPagers.connect(input.pagerDialId, connectedAtOffset)) {
              throw new Error("Capability Provider Pager disappeared while connecting");
            }
          },
        });
      });
    } catch (error) {
      // The connected event may have committed before its opening Pager
      // vanished. Re-run the cold-start sweep to journal that exact drop.
      this.#capabilityProviderPagerStartup = undefined;
      this.ctx.waitUntil(this.#ensureCapabilityProviderPagersReconciled());
      throw error;
    }
  }

  /**
   * Mount a capability on this stream's capability scope. Live provisions are
   * gated on their Pager still being both durably connected and physically
   * attached; a replaced live mount's provider relay is retired even when
   * binding the replacement fails.
   */
  async provideCapability(
    input: CapabilityProvidedPayload,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    await this.#ensureCapabilityProviderPagersReconciled();
    return await this.#serializeCapabilityMutation(async () => {
      const facet = await this.#dialCapabilityHostFacet();
      const state = await this.#capabilityHostState(facet);
      if (input.type === "live") {
        const connectedAtOffset = input.providerPager.connectedAtOffset;
        if (
          !state.capabilityProviderPagers.some(
            (pager) => pager.connectedAtOffset === connectedAtOffset,
          ) ||
          !this.#capabilityProviderPagers.hasPager(connectedAtOffset)
        ) {
          throw new Error("live capability provision's Capability Provider Pager is disconnected");
        }
      }
      const replaced = state.capabilities.find((record) =>
        sameCapabilityPath(record.path, input.path),
      );
      return await facet.provideCapability(input, {
        afterAppend: (record) => {
          // The append has already displaced this row. Retire its relay even
          // if binding the replacement fails; otherwise the old ownership
          // handle would remain active for a mount the table no longer holds.
          if (replaced?.type === "live") this.#capabilityProviderPagers.removeMount(replaced);
          if (input.type === "live") {
            if (record.type !== "live") {
              throw new Error("live capability provision committed a non-live record");
            }
            if (!this.#capabilityProviderPagers.hasPager(input.providerPager.connectedAtOffset)) {
              this.#capabilityProviderPagerStartup = undefined;
              this.ctx.waitUntil(this.#ensureCapabilityProviderPagersReconciled());
              throw new Error(
                `live capability "${input.path.join(".")}" Provider Pager disappeared`,
              );
            }
          }
        },
      });
    });
  }

  /** Remove the current mount at a path (or one exact mount by offset) and retire its live relay. */
  async revokeCapability(input: RevokeCapabilityInput): Promise<void> {
    await this.#ensureCapabilityProviderPagersReconciled();
    await this.#serializeCapabilityMutation(async () => {
      const facet = await this.#dialCapabilityHostFacet();
      const state = await this.#capabilityHostState(facet);
      const record = state.capabilities.find((candidate) =>
        sameCapabilityPath(candidate.path, input.path),
      );
      await facet.revokeCapability(input);
      if (
        record?.type === "live" &&
        (input.providedAtOffset === undefined || input.providedAtOffset === record.providedAtOffset)
      ) {
        this.#capabilityProviderPagers.removeMount(record);
      }
    });
  }

  /** Adopt one short provider call leg after an activation Page (relay-dialed). */
  async activateLiveCapability(
    input: CapabilityProviderPagerActivation,
  ): Promise<CapabilityProviderCallLegRpcTarget | undefined> {
    await this.#ensureCapabilityProviderPagersReconciled();
    const facet = await this.#dialCapabilityHostFacet();
    const state = await this.#capabilityHostState(facet);
    const record = state.capabilities.find(
      (candidate): candidate is Extract<CapabilityRecord, { type: "live" }> =>
        candidate.type === "live" && candidate.providedAtOffset === input.providedAtOffset,
    );
    if (record === undefined) return undefined;
    return this.#capabilityProviderPagers.activate(input, record);
  }

  /**
   * The capability-host FACET's `invokeLiveCapability` dep door: the facet's
   * processor resolved a live mount and needs its provider — acquired through
   * the parent-held Pager (Page → relay lends a short RPC leg → invoke →
   * release at quiescence).
   */
  async invokeLiveCapability(input: {
    args: unknown[];
    path: string[];
    record: Extract<CapabilityRecord, { type: "live" }>;
  }): Promise<unknown> {
    await this.#ensureCapabilityProviderPagersReconciled();
    return await this.#capabilityProviderPagers.invoke(input.record, input.path, input.args);
  }

  /** The facade-side capability doors — see {@link CapabilityHostFacadeWiring}. */
  #capabilityHostFacadeWiring(): CapabilityHostFacadeWiring {
    return {
      invokeCapability: async (input) => {
        await this.#ensureCapabilityProviderPagersReconciled();
        return await (await this.#dialCapabilityHostFacet()).invokeCapability(input);
      },
      describeCapabilities: async () => {
        await this.#ensureCapabilityProviderPagersReconciled();
        return await (await this.#dialCapabilityHostFacet()).describeCapabilities();
      },
      provideCapability: (input) => this.provideCapability(input),
      revokeCapability: (input) => this.revokeCapability(input),
      setPreamble: (input) =>
        this.#serializeCapabilityMutation(async () =>
          (await this.#dialCapabilityHostFacet()).setPreamble(input),
        ),
      removePreamble: (input) =>
        this.#serializeCapabilityMutation(async () =>
          (await this.#dialCapabilityHostFacet()).removePreamble(input),
        ),
    };
  }

  /**
   * Record each connected Pager whose physical WebSocket did not survive a
   * deployment/restart. One disconnected event atomically retires every live
   * mount that references the Pager's connected offset.
   * Cloudflare terminates WebSockets during shutdown but does not promise the
   * dying incarnation enough time to journal every close callback. A fresh
   * incarnation can decide from durable bindings plus runtime-owned sockets,
   * so its first capability operation repairs that state in one exact event.
   */
  async #ensureCapabilityProviderPagersReconciled(): Promise<void> {
    const active = this.#capabilityProviderPagerStartup;
    if (active !== undefined) return await active;
    const startup = this.#reconcileMissingCapabilityProviderPagers();
    this.#capabilityProviderPagerStartup = startup;
    try {
      await startup;
    } catch (error) {
      if (this.#capabilityProviderPagerStartup === startup)
        this.#capabilityProviderPagerStartup = undefined;
      throw error;
    }
  }

  async #reconcileMissingCapabilityProviderPagers(): Promise<void> {
    await this.#serializeCapabilityMutation(async () => {
      const facet = await this.#dialCapabilityHostFacet();
      const state = await this.#capabilityHostState(facet);
      for (const pager of state.capabilityProviderPagers) {
        if (this.#capabilityProviderPagers.hasPager(pager.connectedAtOffset)) continue;
        await facet.disconnectCapabilityProviderPager({
          connectedAtOffset: pager.connectedAtOffset,
        });
        this.#capabilityProviderPagers.removePager(pager.connectedAtOffset);
      }
    });
  }

  async #disconnectCapabilityProviderPager(connectedAtOffset: number): Promise<void> {
    await this.#serializeCapabilityMutation(async () => {
      const facet = await this.#dialCapabilityHostFacet();
      await facet.disconnectCapabilityProviderPager({ connectedAtOffset });
      this.#capabilityProviderPagers.removePager(connectedAtOffset);
    });
  }

  /** Serialize this scope's low-volume capability control-plane mutations. */
  #serializeCapabilityMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#capabilityMutationTail.then(mutation);
    this.#capabilityMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Cross-facet presentation forward: the "agent" facet observed a committed
   * agent runtime transition; replay it into the sibling "slack-agent" facet
   * (whose DRIVEN runner owns the Slack presentation fold) when one is
   * subscribed here. Best-effort by design — presentation is cosmetic and the
   * freshness-gated paint re-derives from the fold.
   */
  presentAgentRuntimeTransition(args: { transition: unknown }): void {
    const entry = this.#coreProcessorState.subscriptions.outbound.byName["slack-agent"];
    const receiver = entry?.configuration.receiver;
    if (receiver?.action !== "processor-wake" || receiver.placement !== "facet") return;
    this.#runInBackground(async () => {
      const facet = await this.#dialProcessorFacet("slack-agent");
      disposeAcknowledgedRpcResult(
        await facet.presentAgentRuntimeTransition(args),
        "present-agent-runtime-transition",
      );
    });
  }

  /**
   * The subscription catalog: configured subscriptions joined with their
   * durable cursor rows — `streams.get(path).subscriptions.list()`. Lag is
   * `head − confirmed` (durable cursors advance over EVERY offset, ephemeral
   * included).
   *
   * TODO(facet-lag-display): for processor-wake rows the durable cursor is
   * the runner's REPORTED checkpoint, which trails the runner's real position
   * until the next wake cycle's report — a healthy facet can read as lagging
   * here for minutes while `waitUntilProcessed` (which asks the runner
   * directly) is precise. Confirm-on-batch-settle for facet rows, or an
   * async describe that reads the facet's snapshot offset, would make the
   * operator's primary health signal honest; both touch the hosted
   * checkpoint-report plumbing, so this stays display-only lag for now.
   */
  listSubscriptions(): StreamSubscriptionListEntry[] {
    const head = this.#coreProcessorState.maxOffset;
    return Object.entries(this.#coreProcessorState.subscriptions.outbound.byName).map(
      ([name, entry]) => {
        const receiver = entry.configuration.receiver;
        const row = this.#subscriptionCursorStore.get(name);
        const confirmedOffset = row?.confirmedOffset ?? 0;
        return {
          name,
          action: receiver.action,
          ...(receiver.action === "processor-wake" && receiver.placement === "facet"
            ? { placement: "facet" as const }
            : {}),
          configuredAtOffset: entry.configuredAtOffset,
          status:
            row?.status ??
            (entry.deliveryHalted !== undefined ? ("halted" as const) : ("active" as const)),
          lag: Math.max(0, head - confirmedOffset),
          confirmedOffset,
          lastError: row?.lastError ?? null,
        };
      },
    );
  }

  /** One subscription's full description: committed configuration plus the
   * durable confirmed cursor and retry state. */
  describeSubscription(args: { name: string }): StreamSubscriptionDescription | null {
    const entry = this.#coreProcessorState.subscriptions.outbound.byName[args.name];
    if (entry === undefined) return null;
    const row = this.#subscriptionCursorStore.get(args.name);
    const confirmedOffset = row?.confirmedOffset ?? 0;
    return {
      name: args.name,
      configuration: entry.configuration,
      configuredAtOffset: entry.configuredAtOffset,
      status: row?.status ?? (entry.deliveryHalted !== undefined ? "halted" : "active"),
      lag: Math.max(0, this.#coreProcessorState.maxOffset - confirmedOffset),
      confirmedOffset,
      attempt: row?.attempt ?? 0,
      nextAttemptAt: row?.nextAttemptAt ?? null,
      lastError: row?.lastError ?? null,
    };
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
   * 2. Durable event rows, the shared offset allocator high-water mark, and
   *    the new core state are written in one await-free turn. Ephemeral event
   *    bodies enter only the bounded in-memory buffer. After this line the
   *    append has succeeded.
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
    name: string;
    subscriptionConfiguredEvent: CommittedSubscriptionConfiguredEvent;
  } {
    const canonical = CoreProcessorContract.parseEventInput({
      type: "events.iterate.com/stream/subscription-configured",
      payload: args.configuration,
    }).payload;
    if (canonical.receiver.action !== "copy-to-stream") {
      throw new Error("setCopySubscription requires a copy action");
    }
    if (canonical.name === undefined && args.idempotencyKey === undefined) {
      throw new Error(
        "a nameless copy subscription requires idempotencyKey so setup is safe to retry",
      );
    }

    const explicitName = canonical.name;
    const existing =
      explicitName === undefined
        ? undefined
        : this.#coreProcessorState.subscriptions.outbound.byName[explicitName];

    let configuredEvent: StreamEvent;
    if (existing !== undefined && jsonValuesEqual(existing.configuration, canonical)) {
      const event = this.getEvent({ offset: existing.configuredAtOffset });
      if (event?.type !== "events.iterate.com/stream/subscription-configured") {
        throw new Error(
          `subscription "${explicitName}" points to a missing configuration event at offset ${existing.configuredAtOffset}`,
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
      name: subscriptionNameForConfiguredEvent(subscriptionConfiguredEvent),
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
    name: string;
    expectedReceiverPath: string;
  }):
    | { status: "removed"; subscriptionRemovedEvent: CommittedSubscriptionRemovedEvent }
    | { status: "already-absent" } {
    const removal = CoreProcessorContract.parseEventInput({
      type: "events.iterate.com/stream/subscription-removed",
      payload: { name: args.name, reason: "requested" },
    }).payload;
    const name = removal.name;
    const expectedReceiverPath = canonicalizeStreamPath(args.expectedReceiverPath);
    const configured = this.#coreProcessorState.subscriptions.outbound.byName[name];
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
            payload: { name, reason: "requested" },
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
        const name = subscriptionNameForConfiguredEvent(configured);
        if (this.#eventSender.connections.connectionKind(name) === "session") {
          throw new Error(
            `subscription name "${name}" is already used by a live session connection`,
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
    // Keep this section await-free: durable rows plus the allocator high-water
    // mark are the append boundary.
    // The KV state checkpoint is DEBOUNCED (see
    // #checkpointCoreProcessorState) — event rows are the durable truth, and
    // boot catch-up folds past a lagging checkpoint by design.
    assertCoreProcessorCheckpointGrowthFits({
      before: this.#coreProcessorState,
      events: newEvents,
      next: workingState,
    });
    const durableEvents = newEvents.filter((event) => event.ephemeral !== true);
    const ephemeralEvents = this.#ephemeralEvents.prepare(
      newEvents.filter((event) => event.ephemeral === true),
    );
    const durableByteLengths = this.#log.insert(durableEvents);
    this.#log.advanceHighestAssignedOffset(workingState.maxOffset);
    this.#ephemeralEvents.commit(ephemeralEvents);

    const sizedByOffset = new Map<number, SizedStreamEvent>();
    for (const [index, event] of durableEvents.entries()) {
      sizedByOffset.set(event.offset, { event, byteLength: durableByteLengths[index]! });
    }
    for (const event of ephemeralEvents) sizedByOffset.set(event.event.offset, event);
    const justCommittedEvents = newEvents.map((event) => sizedByOffset.get(event.offset)!);

    this.#coreProcessorState = workingState;
    this.#checkpointCoreProcessorState(newEvents.length);
    this.#metrics.ingress.bump(
      Date.now(),
      newEvents.length,
      justCommittedEvents.reduce((sum, entry) => sum + entry.byteLength, 0),
    );
    this.#refreshLiveState();

    // 3. Reconcile every mutable/runtime projection from the committed state.
    // Each operation is isolated so one defect cannot skip its siblings. Any
    // failure gets an immediate native alarm in this same output-gated turn;
    // the alarm and a fresh incarnation both run the same level checks.
    this.#reconcileCommittedState({
      justCommittedEvents,
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
    return this.#ephemeralEvents.getByOffset(args.offset) ?? this.#log.getByOffset(args.offset);
  }

  #readEventsSized(args: {
    afterOffset: number;
    beforeOffset: number;
    eventTypes?: readonly string[];
    limit: number;
    includeEphemeral: boolean;
  }): SizedStreamEvent[] {
    const durableEvents = this.#log.getRangeSized({
      afterOffset: args.afterOffset,
      beforeOffset: args.beforeOffset,
      eventTypes: args.eventTypes,
      limit: args.limit,
    });
    if (!args.includeEphemeral) return durableEvents;

    const ephemeralEvents = this.#ephemeralEvents.getRangeSized({
      afterOffset: args.afterOffset,
      beforeOffset: args.beforeOffset,
      eventTypes: args.eventTypes,
      limit: args.limit,
    });
    return [...durableEvents, ...ephemeralEvents]
      .sort((left, right) => left.event.offset - right.event.offset)
      .slice(0, args.limit);
  }

  /**
   * Synchronous committed-event range read. Keep await-free (see getEvent).
   * Ephemeral events from the current Durable Object incarnation are excluded
   * unless `includeEphemeral` is explicitly requested.
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
    return this.#readEventsSized({
      afterOffset: args.afterOffset ?? 0,
      beforeOffset: args.beforeOffset ?? Number.MAX_SAFE_INTEGER,
      eventTypes: args.eventTypes,
      limit: limit ?? DEFAULT_GET_EVENTS_LIMIT,
      includeEphemeral: args.includeEphemeral === true,
    }).map((entry) => entry.event);
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
   * fold barrier: `maxOffset` is the highest assigned offset (ephemeral events hold
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
        const configuredSubscriptionNames = new Set(
          Object.keys(state.subscriptions.outbound.byName),
        );

        // A lifecycle interruption can land after a removal event commits but
        // before its post-commit cursor cleanup. Reduced source configuration
        // is authoritative on every boot, not only after a reducer-version
        // migration.
        pruneOrphanedSubscriptionCursorRows(
          this.#subscriptionCursorStore,
          configuredSubscriptionNames,
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
    // The fold recovers maxOffset from durable rows. The assigned floor also
    // covers memory-only ephemeral offsets whose bodies disappeared on
    // restart or FIFO eviction. Without it, rebuild could reissue an offset a
    // session callback already received (the browser event table hard-ABORTs
    // on one offset carrying different JSON).
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

    const configuredSubscriptionNames = new Set(Object.keys(state.subscriptions.outbound.byName));
    this.ctx.storage.transactionSync(() => {
      pruneOrphanedSubscriptionCursorRows(
        this.#subscriptionCursorStore,
        configuredSubscriptionNames,
      );
      // The SQLite cursor rows survived the reducer-version change. Keep
      // monotonic acknowledged progress, but clear stale failure state so
      // every surviving subscription gets a fresh attempt under the new reducer.
      clearSubscriptionCursorFailuresAfterStateRebuild(
        this.#subscriptionCursorStore,
        configuredSubscriptionNames,
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
   * default. `replayAfterOffset: 0` replays durable events plus any ephemeral
   * events still buffered in this incarnation; `3` starts replay at offset 4.
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
    args: Parameters<Stream["openConnection"]>[0],
    // Internal relay plumbing (which client-given Pager this open binds) rides a
    // separate parameter, never the public arg bag: the relay spreads the
    // caller's args through, so anything merged into their shape would be
    // client-spoofable by default. Public callers cannot reach this DO
    // directly; the relay generates the id.
    relay?: { subscriberPagerId: string },
  ): StreamConnectionHandle {
    const connectionKey = args.connectionKey?.trim() || crypto.randomUUID();
    if (this.#coreProcessorState.subscriptions.outbound.byName[connectionKey] !== undefined) {
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

    this.#subscriberPagers.bind({
      connectionKey,
      subscriberPagerId: relay?.subscriberPagerId,
      filter: filterSpec,
      events: args.events,
    });

    return new StreamConnectionRpcTarget({
      close: () => connection.close("closed-by-owner"),
      isLive: () => connection.isLive(),
      connectionKey,
      streamMaxOffset: this.#coreProcessorState.maxOffset,
    });
  }

  /**
   * One-shot convenience over `openConnection()`: replay durable and currently
   * buffered ephemeral events from the requested cursor, then receive new
   * events until a caller predicate accepts one.
   *
   * Rides a session connection, so it can match an ephemeral event already in
   * this incarnation's memory or one appended after the wait opens.
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

  getProcessorRuntimeState(args: { name: string }): Promise<ProcessorRuntimeState | null> {
    return this.#eventSender.connections.getProcessorRuntimeState(args.name);
  }

  /**
   * The uniform barrier: resolve once the named subscription's receiver has
   * durably processed through `offset` — one verb for every receiver kind.
   *
   * The delegation split: PROCESSOR-WAKE rows delegate to the hosted runner's
   * own barrier, which reads the runner's acknowledged cursor directly — so a
   * live connection's progress counts immediately instead of waiting for the
   * next wake cycle's checkpoint report. Facet placement dials the facet
   * facade; expression placement dials the same public `waitUntilProcessed`
   * verb on the receiver expression's `processor` node. Every OTHER kind
   * resolves off the durable cursor row (`confirmed_offset >= offset`): the
   * awaited push acknowledgement (copy/itx/webhook).
   *
   * One-shot like `waitForEvent`: it dies with the RPC caller or this
   * incarnation. A cursor-lane timeout carries the modelled wait-timeout
   * prefix; delegated lanes reject with the runner's own timeout error.
   */
  async waitUntilProcessed(
    name: string,
    args: { offset: number; timeoutMs?: number },
  ): Promise<void> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error("waitUntilProcessed requires a subscription name");
    }
    if (!Number.isSafeInteger(args.offset) || args.offset < 0) {
      throw new Error("waitUntilProcessed offset must be a non-negative safe integer.");
    }
    const timeoutMs = args.timeoutMs ?? 20_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("waitUntilProcessed timeoutMs must be a positive number.");
    }
    const configured = this.#coreProcessorState.subscriptions.outbound.byName[trimmedName];
    if (configured === undefined) {
      throw new Error(`subscription "${trimmedName}" does not exist`);
    }

    const receiver = configured.configuration.receiver;
    if (receiver.action === "processor-wake") {
      if (receiver.placement === "facet") {
        const facet = await this.#dialProcessorFacet(trimmedName);
        await facet.waitUntilProcessed({ offset: args.offset, timeoutMs, name: trimmedName });
        return;
      }
      // Swap the expression's trailing `wakeStreamProcessor` property step for
      // the public `waitUntilProcessed` verb on the same `processor` node.
      const value = await this.#callExpressionProcessorNode(trimmedName, [
        "waitUntilProcessed",
        { offset: args.offset, timeoutMs },
      ]);
      disposeAcknowledgedRpcResult(value, "wait-until-processed");
      return;
    }

    const confirmed = Promise.withResolvers<void>();
    let settled = false;
    const waiter = {
      check: () => {
        if (settled) return;
        if (this.#coreProcessorState.subscriptions.outbound.byName[trimmedName] === undefined) {
          settled = true;
          confirmed.reject(new Error(`subscription "${trimmedName}" was removed while waiting`));
          return;
        }
        const row = this.#subscriptionCursorStore.get(trimmedName);
        if (row !== undefined && row.confirmedOffset >= args.offset) {
          settled = true;
          confirmed.resolve();
        }
      },
    };
    this.#confirmationWaiters.add(waiter);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const row = this.#subscriptionCursorStore.get(trimmedName);
      confirmed.reject(
        new Error(
          `${STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX}subscription "${trimmedName}" confirmed ` +
            `${row?.confirmedOffset ?? 0} < ${args.offset} after ${timeoutMs}ms` +
            `${row === undefined ? "" : ` (status: ${row.status})`}`,
        ),
      );
    }, timeoutMs);

    try {
      waiter.check();
      await confirmed.promise;
    } finally {
      clearTimeout(timer);
      this.#confirmationWaiters.delete(waiter);
    }
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
    // liveState watchers on the hibernatable socket lane: state only changes
    // while this DO is awake, so scheduling here — the one materialization
    // point — is complete coverage; the flusher reads state at flush time.
    // Cursor cleanup can reach this before the constructor assigns the
    // fields; the optional reads are therefore intentional.
    this.#liveStatePagers?.scheduleFlush();
    // Facet lanes refresh-then-flush: a cursor mutation is the parent-side
    // signal that a hosted delivery just landed in a facet, so its watchers'
    // state must be re-pulled before pushing (no-op per lane without Pagers).
    for (const lane of this.#facetLiveStateLanes?.values() ?? []) lane.refreshThenFlush();
    const liveState = this.#liveState;
    if (liveState?.observed !== true || this.#liveStateRefreshScheduled) return;
    this.#liveStateRefreshScheduled = true;
    queueMicrotask(() => {
      this.#liveStateRefreshScheduled = false;
      liveState.setState(this.#readRuntimeState());
    });
  }

  #readRuntimeState(): StreamRuntimeDebugState {
    return {
      coreProcessorState: this.#coreProcessorState,
      runtime: {
        connections: this.#eventSender.connections.runtimeState(),
        dormantSubscribers: this.#subscriberPagers.dormantRuntimeState(),
        subscriptions: this.#eventSender.subscriptionRuntimeState(),
        metrics: this.#metrics.report(Date.now()),
        ephemeralEvents: this.#ephemeralEvents.runtimeState(),
        storageSizeBytes: this.ctx.storage.sql.databaseSize,
      },
    };
  }

  // ===========================================================================
  // Stream Subscriber Pagers: client-given hibernatable return channels for
  // idle-closed session connections. All mechanics live in the registry;
  // this class only routes the platform entry points to it.
  // ===========================================================================

  /** The Stream DO's fetch surface: the Live State Pager (unkeyed = runtime
   * debug state; keyed = one facet processor's live state), the Capability
   * Provider Pager for the capability-host facet, and the Stream Subscriber
   * Pager upgrades — nothing else. */
  async fetch(request: Request): Promise<Response> {
    const lane = liveStatePagerLaneKey(request);
    if (lane !== undefined) {
      // A socket upgrade is a read: it must not create a lane (whose pulls
      // dial the named facet) for a caller-chosen key the committed catalog
      // does not place under facet placement. Same gate as processorFacade.
      try {
        const receiver = this.#requireProcessorWakeSubscription(lane);
        if (receiver.placement !== "facet") {
          throw new Error(`subscription "${lane}" does not run under facet placement`);
        }
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 404 },
        );
      }
      return (
        (await this.#facetLiveStateLane(lane).acceptUpgrade(request)) ??
        Response.json(
          { error: "facet liveState lanes accept only lane-headed WebSocket upgrades" },
          { status: 400 },
        )
      );
    }
    if (request.headers.get(CAPABILITY_PROVIDER_PAGER_HEADER) !== null) {
      // Same catalog gate as the facet liveState lanes: a Pager may only
      // attach to a stream whose committed catalog places the capability-host
      // subscription under facet placement (the host create batch configures
      // it), so a caller cannot park provider sockets on arbitrary streams.
      try {
        const receiver = this.#requireProcessorWakeSubscription(
          CapabilityHostProcessorContract.slug,
        );
        if (receiver.placement !== "facet") {
          throw new Error("the capability-host subscription does not run under facet placement");
        }
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 404 },
        );
      }
      return this.#capabilityProviderPagers.acceptUpgrade(request);
    }
    return (
      (await this.#liveStatePagers.acceptUpgrade(request)) ??
      this.#subscriberPagers.acceptUpgrade(request)
    );
  }

  /** Pagers are one-way (this DO → relay); inbound frames are ignored. */
  webSocketMessage(): void {}

  /**
   * A closed socket disappears from `getWebSockets`, which is most of the
   * cleanup: the registry stops reporting it and the connection (if any)
   * keeps today's non-idle-eligible session semantics. But when the socket
   * carried a DORMANT subscriber, its closing is the subscriber's real
   * departure — the `"idle"` close deliberately was not one — so audit and
   * presence consumers get the durable `"departed"` fact here. Idempotent
   * per socket; best-effort like every connection-close observation.
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    // A closed Capability Provider Pager is its provider's real departure:
    // journal the disconnect so reduction retires every mount it owned.
    const connectedAtOffset = this.#capabilityProviderPagers.connectedAtOffset(ws);
    if (connectedAtOffset !== undefined) {
      await this.#ensureCapabilityProviderPagersReconciled();
      await this.#disconnectCapabilityProviderPager(connectedAtOffset);
      return;
    }
    const departed = this.#subscriberPagers.departedOnClose(ws);
    if (departed === undefined) return;
    try {
      this.#append({ authority: "core-event" }, [
        {
          type: "events.iterate.com/stream/connection-closed",
          idempotencyKey: internalStreamId("stream-subscriber-pager-departed", departed.pagerId),
          payload: { connectionKey: departed.connectionKey, reason: "departed" },
        },
      ]);
    } catch (error) {
      if (!isDurableObjectLifecycleError(error)) throw error;
    }
  }

  /** Shared by every Pager lane; a fault is only ever explicable after the fact. */
  webSocketError(ws: WebSocket, error: unknown): void {
    if (this.ctx.getTags(ws).includes(CAPABILITY_PROVIDER_PAGER_TAG)) {
      // Terminal for the provider Pager: close it so webSocketClose journals
      // the disconnect and the relay can reconnect and re-provide.
      this.#capabilityProviderPagers.handleError(ws, error);
      return;
    }
    this.#liveStatePagers.pagerError(error);
  }

  // ===========================================================================
  // Operator/admin verbs.
  // ===========================================================================

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
const StreamAppendInput = StreamEventInputSchema.safeExtend({
  offset: z.number().int().nonnegative().optional(),
}).strict();

function parseStreamDurableObjectName(name: string | undefined) {
  if (!name) {
    throw new Error("Stream Durable Object must be addressed by name.");
  }
  return DurableObjectNameCodec.parse(name, { allowNullProjectId: true });
}
