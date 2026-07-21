// RPC stub retention for stream delivery sinks — the ONLY streams file that
// knows transports exist.
//
// A sink is the live callback the stream invokes to deliver batches. It
// arrives in one of two ways: an ephemeral subscriber passes it as a
// `subscribe()` PARAMETER, and a durable subscriber RETURNS it from the
// `wakeStreamSubscriber` poke. Either way the stream keeps a relationship to
// the callback after the RPC method that carried it returns, which is exactly
// what "retaining" means: duplicate the stub when the transport exposes
// `.dup()`, dispose the duplicate on close.
//
// Ownership rules differ by direction, and this module is where that
// knowledge is quarantined:
// - Parameters: Workers RPC duplicates stubs in call parameters as of the
//   2026-01-20 `rpc_params_dup_stubs` compatibility change, matching Cap'n
//   Web's ownership model — so we dup defensively and dispose our duplicate.
//   https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call
//   https://github.com/cloudflare/capnweb#resource-management-and-disposal
// - Return values: ownership transfers to the caller (us). We retain what the
//   poke returned and are responsible for disposing it.
//
// Delivery is fire-and-forget by design (the pump never awaits a batch); the
// asymmetry between ephemeral and durable subscribers is WHO PULLS THE RESULT:
// ephemeral batch results are disposed unpulled — zero subscriber-originated
// return frames on the wire — while durable batch results are pulled (never
// awaited) purely as the prompt dead-connection signal. See
// `retainProcessEventBatch` below and the wire tests in
// stream-wire.e2e.test.ts.

import { disposeIgnoredRpcResult, isThenable, retainCallback } from "iterate/sdk/capnweb";
import { StreamReceiverUnavailableError } from "iterate/processors";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamPingInput,
  StreamPingReply,
  StreamPushEventBatch,
  StreamSubscriberPing,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
  StreamWebhookDelivery,
} from "iterate/processors";
import { evaluateItxExpression, type ItxExpression } from "../../itx/expression.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import type { SubscriberDial } from "./stream-subscribers.ts";

// workerd's public, documented verdict for an entrypoint whose response is
// blocked on a promise the runtime can prove will never settle. Workers RPC
// exposes no code/flag for this failure: it crosses the boundary as a plain
// Error with this message (workerd's js-rpc-test.js asserts the same text).
// Keep the match to the stable semantic sentence, not the trailing docs URL.
const WORKERS_HUNG_ENTRYPOINT_MESSAGE =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

/** Whether a remote Worker entrypoint was canceled because it can never settle. */
export function isWorkersHungEntrypointError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    error.message.startsWith(WORKERS_HUNG_ENTRYPOINT_MESSAGE)
  );
}

/**
 * Translate a transport-level receiver cancellation into the delivery
 * spine's explicit availability contract. It says the receiver cannot ack;
 * it is not evidence that any event in the batch is poison.
 */
function rethrowPushEvaluationError(error: unknown): never {
  if (isWorkersHungEntrypointError(error)) {
    throw new StreamReceiverUnavailableError(
      `project worker receiver was canceled before acknowledgement: ${error.message}`,
      { cause: error },
    );
  }
  throw error;
}

/**
 * Per-call delivery options, consumed LOCALLY by the retained wrapper — never
 * serialized, never on the wire. `onSettled` fires when the durable lane's
 * pulled result settles (the subscriber's ingest resolved/rejected); on the
 * ephemeral lane, where results are disposed unpulled by design, it never
 * fires.
 */
export type DeliveryOptions = {
  onSettled?: (outcome: "ok" | "error") => void;
};

/** The pump-facing delivery callback: fire-and-forget, disposable, broken-transport aware. */
export type RetainedProcessEventBatch = ((
  batch: Parameters<ProcessEventBatch>[0],
  opts?: DeliveryOptions,
) => void) &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
    /**
     * Dispatched-but-unsettled deliveries (durable lane only, where results
     * are pulled). Idle teardown consults this: a sink with an unsettled
     * batch belongs to a wedged subscriber, and its watermark must not be
     * advanced as if the batch were digested.
     */
    pendingDeliveries?(): number;
  };

/**
 * Retains a delivery sink and wraps it in the pump's fire-and-forget calling
 * convention.
 *
 * Without `onDeliveryError` (ephemeral subscribers) the batch result is
 * disposed WITHOUT ever being pulled, so the remote never ships a resolution —
 * frames flow in one direction only. With it (durable subscribers) the result
 * is pulled — never awaited, never gating the pump — because a dead stub
 * rejects every call, and observing that rejection is the only reliable,
 * PROMPT "this connection is a corpse" signal (`onRpcBroken` is best-effort
 * and can be a pipelined fake). One resolve frame per batch is the price of
 * millisecond-grade dead-connection detection on the lane voice rides.
 */
export function retainProcessEventBatch(
  processEventBatch: ProcessEventBatch,
  opts: {
    onDeliveryError?: (error: unknown) => void;
    /**
     * Runs after the retained stub is disposed — the hook that lets a caller
     * tie the handshake's runtime-state and ping capabilities to this sink,
     * so those sidecars outlive every batch call but not the connection.
     */
    onDisposed?: () => void;
  } = {},
): RetainedProcessEventBatch {
  // `retainCallback` owns the transport dance (dup, idempotent dispose, and
  // the defensive onRpcBroken wiring — see iterate/sdk/capnweb/retain.ts for why that
  // wiring is subtle); this layer adds only the pump's delivery semantics.
  const retained = retainCallback<Parameters<ProcessEventBatch>[0]>(processEventBatch);
  const onDeliveryError = opts.onDeliveryError;
  let pendingDeliveries = 0;
  const callback: RetainedProcessEventBatch = Object.assign(
    (batch: Parameters<ProcessEventBatch>[0], opts?: DeliveryOptions) => {
      let result: unknown;
      try {
        result = retained(batch);
      } catch (error) {
        // A disposed/broken stub can throw synchronously at call time.
        onDeliveryError?.(error);
        opts?.onSettled?.("error");
        return;
      }
      if (onDeliveryError !== undefined && isThenable(result)) {
        // Delivery stays fire-and-forget (the pump never awaits the remote
        // result), but the rejection must be observed: a dead stub rejects
        // every call, and swallowing that left broken connections in place
        // forever. Dispose only after settle; disposing before the result is
        // pulled opts out of observing the rejection signal this path needs.
        pendingDeliveries += 1;
        void Promise.resolve(result)
          .then(
            () => {
              pendingDeliveries -= 1;
              opts?.onSettled?.("ok");
            },
            (error: unknown) => {
              pendingDeliveries -= 1;
              try {
                onDeliveryError(error);
              } finally {
                opts?.onSettled?.("error");
              }
            },
          )
          .finally(() => {
            disposeIgnoredRpcResult(result);
          });
        return;
      }
      disposeIgnoredRpcResult(result);
      // Ephemeral lane (results disposed unpulled): "settled" is meaningless
      // here — the subscriber's consumption is self-reported instead — but a
      // LOCAL sink's synchronous return is a genuine settle.
      if (onDeliveryError !== undefined) opts?.onSettled?.("ok");
    },
    {
      pendingDeliveries: () => pendingDeliveries,
      [Symbol.dispose]() {
        try {
          retained[Symbol.dispose]();
        } finally {
          opts.onDisposed?.();
        }
      },
    },
  );
  // For durable subscribers, the onDeliveryError path still observes broken
  // stubs even when this registration was only a pipelined fake.
  if (retained.onRpcBroken) callback.onRpcBroken = retained.onRpcBroken;
  return callback;
}

/**
 * Retains a request/response capability for a connection lifetime: unlike the
 * fire-and-forget sink, these calls PULL their results (that's their whole
 * point) and dispose the result stub after the value lands. One helper for
 * every such capability so the retain→call→pull→dispose dance exists once.
 */
function retainPulledCall<In, Out>(
  callback: ((input: In) => Out | Promise<Out>) | undefined,
): (((input: In) => Out | Promise<Out>) & Disposable) | undefined {
  if (callback === undefined || typeof callback !== "function") return undefined;
  const retained = retainCallback<In>(callback);
  return Object.assign(
    (input: In) => {
      const result = retained(input);
      if (isThenable(result)) {
        return Promise.resolve(result).finally(() =>
          disposeIgnoredRpcResult(result),
        ) as Promise<Out>;
      }
      disposeIgnoredRpcResult(result);
      return result as Out;
    },
    {
      [Symbol.dispose]() {
        retained[Symbol.dispose]();
      },
    },
  );
}

/** Retains a hosted processor's live runtime-state capability for the connection lifetime. */
export function retainGetProcessorRuntimeState(
  getRuntimeState: GetProcessorRuntimeState | undefined,
): (GetProcessorRuntimeState & Disposable) | undefined {
  const retained = retainPulledCall<void, ProcessorRuntimeState>(getRuntimeState);
  if (retained === undefined) return undefined;
  return Object.assign(() => retained(undefined), {
    [Symbol.dispose]: () => retained[Symbol.dispose](),
  });
}

/**
 * Retains a subscriber's ping capability for the connection lifetime (see
 * {@link StreamSubscriberPing} in rpc-types.ts).
 */
export function retainSubscriberPing(
  ping: StreamSubscriberPing | undefined,
): RetainedSubscriberPing | undefined {
  return retainPulledCall<StreamPingInput, StreamPingReply>(ping);
}

/** A retained ping: callable like the raw capability, disposable with its connection. */
export type RetainedSubscriberPing = ((
  input: StreamPingInput,
) => StreamPingReply | Promise<StreamPingReply>) &
  Disposable;

type RetainedWakeHandshakeResponse = {
  checkpointOffset: number;
  sink: RetainedProcessEventBatch;
  subscriber?: unknown;
  getRuntimeState?: GetProcessorRuntimeState & Disposable;
  ping?: RetainedSubscriberPing;
};

/**
 * Takes ownership of a wake handshake returned over Workers RPC.
 *
 * The result object owns the original sink/runtime-state/ping stubs as one
 * disposal group. Duplicate each capability needed by the live connection,
 * then dispose that original result immediately; otherwise workerd eventually
 * reports the dropped group as an undisposed RPC stub. The retained
 * capabilities and any caller-owned resources are tied to the sink's lifetime.
 */
export function retainWakeHandshakeResponse(args: {
  value: unknown;
  onDeliveryError: (error: unknown) => void;
}): RetainedWakeHandshakeResponse {
  let originalReleased = false;
  const releaseOriginal = () => {
    if (originalReleased) return;
    originalReleased = true;
    disposeIgnoredRpcResult(args.value);
  };

  let getRuntimeState: (GetProcessorRuntimeState & Disposable) | undefined;
  let ping: RetainedSubscriberPing | undefined;
  let sink: RetainedProcessEventBatch | undefined;
  let retainedReleased = false;
  const releaseRetained = () => {
    if (retainedReleased) return;
    retainedReleased = true;
    let firstError: unknown;
    for (const release of [
      () => ping?.[Symbol.dispose](),
      () => getRuntimeState?.[Symbol.dispose](),
    ]) {
      try {
        release();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };

  let ownershipTransferred = false;
  try {
    const response = parseWakeHandshake(args.value);
    getRuntimeState = retainGetProcessorRuntimeState(response.getRuntimeState);
    ping = retainSubscriberPing(response.ping);
    sink = retainProcessEventBatch(response.sink, {
      onDeliveryError: args.onDeliveryError,
      onDisposed: releaseRetained,
    });
    releaseOriginal();
    ownershipTransferred = true;
    return {
      checkpointOffset: response.checkpointOffset,
      sink,
      subscriber: response.subscriber,
      getRuntimeState,
      ping,
    };
  } finally {
    if (!ownershipTransferred) {
      try {
        if (sink === undefined) releaseRetained();
        else sink[Symbol.dispose]();
      } finally {
        releaseOriginal();
      }
    }
  }
}

// =============================================================================
// The dial: how the spine reaches subscribers over real transports.
// =============================================================================

/**
 * Builds the spine's {@link SubscriberDial}. Wake and push share ONE lane: the
 * persisted itx expression is evaluated against a fresh local authority root.
 * The owning Durable Object constructs that root through the same scoped-itx
 * factory as `env.ITX.get()`, without turning in-process delivery into a
 * loopback Worker invocation. Everything transport-shaped — retention of
 * returned sinks, result ownership, and expression walking over RPC — stays
 * here.
 */
export function createSubscriberDial(deps: {
  /** The stream's projectId; `null` = global stream (deployment authority root). */
  projectId: string | null;
  /** The Durable Object's `ctx.exports`, used only for project-egress webhooks. */
  exports: unknown;
  /** Creates a fresh in-process, stream-delivery-authorized itx root. */
  createAuthorityRoot(): unknown;
  /** Where durable-sink delivery rejections land (spine: close → re-poke). */
  onDurableDeliveryError(subscriptionKey: string, error: unknown): void;
}): SubscriberDial {
  /** The webhook lane's cached project-egress fetcher, dropped on failure. */
  let webhookEgress: ReturnType<typeof projectEgressFetcher> | undefined;

  return {
    /**
     * One poke: evaluate the wake expression to the handshake response —
     * checkpoint plus a live sink whose ownership transfers to this stream
     * (returned-stub semantics:
     * https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).
     * The sink is retained with the durable lane's result-pulling liveness
     * policy attached. The local root owns no remote lifetime; the returned
     * handshake value still transfers its own RPC disposal group.
     */
    async poke(expression: ItxExpression, request: StreamSubscriberWakeRequest) {
      const { value } = await evaluateItxExpression(
        deps.createAuthorityRoot(),
        toInvocation(expression, request),
      );
      return retainWakeHandshakeResponse({
        value,
        onDeliveryError: (error) => deps.onDurableDeliveryError(request.subscriptionKey, error),
      });
    },

    /**
     * One push delivery: evaluate the expression to a sink and invoke it with
     * the batch — `["processEventBatch"]` reaches the project root's own
     * dispatch point (which delegates to the project worker) and
     * `["streams", ["get", path], "acceptCrossPost"]` reaches a sibling stream —
     * through exactly the calls ordinary user code would make. The
     * awaited resolve is the ack; a reject propagates to the spine's
     * retry/park machine. Each evaluation receives a fresh local root; only
     * the receiver selected by the expression crosses RPC.
     */
    async push(expression: ItxExpression, batch: StreamPushEventBatch) {
      let value: unknown;
      try {
        ({ value } = await evaluateItxExpression(
          deps.createAuthorityRoot(),
          toInvocation(expression, batch),
        ));
      } catch (error) {
        rethrowPushEvaluationError(error);
      }
      try {
        disposeIgnoredRpcResult(value);
      } catch (error) {
        // Evaluation resolving is the subscriber's acknowledgement. A cleanup
        // failure is observable, but must not turn that ack into a retry and
        // deliver the same batch twice.
        console.warn("stream push RPC result dispose failed after acknowledgement", { error });
      }
    },

    /**
     * One webhook delivery: POST the single-event envelope as JSON. A 2xx is
     * the ack; anything else (or a network failure) rejects into the spine's
     * retry/park machine. The receiver is outside the itx world — no root, no
     * stubs, just HTTP — but the request rides the PROJECT EGRESS lane, never
     * bare global fetch: webhook config is appendable by any project
     * principal (including agent scripts whose ordinary egress is jailed), so
     * an un-attributed fetch here would be a durable event-exfiltration
     * channel that bypasses egress policy (thermo round 3, blocker 1). Which
     * is also why webhooks require a project scope: a global stream has no
     * egress identity to attribute the POST to.
     */
    async webhook(url: string, delivery: StreamWebhookDelivery) {
      if (deps.projectId === null) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      // Webhook drains deliver per EVENT, so a per-POST egress binding mint
      // would be paid at the highest possible rate. Any failure drops it and
      // the retry re-mints.
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
        // The body is never read; cancel it so the connection is released.
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

/**
 * Converts a delivery expression into its invocation: the final step MUST be
 * a property step naming the method, and the dial turns it into a CALL step
 * so the invocation happens receiver-bound on the remote side. Reading the
 * method as a property and applying it locally worked in-process but DETACHED
 * the method from `this` across Workers RPC to the selected remote receiver
 * (thermo round 2, blocker 1: every cross-post delivery failed with "Cannot read
 * properties of undefined (reading 'auth')"). Config validation enforces the
 * tail shape at append time; this re-check protects hand-edited state.
 */
function toInvocation(expression: ItxExpression, payload: unknown): ItxExpression {
  const tail = expression.at(-1);
  if (typeof tail !== "string") {
    throw new Error("delivery expression must end in a property step naming the method to invoke");
  }
  return [...expression.slice(0, -1), [tail, payload]];
}

/**
 * Structural check on what a wake expression evaluated to. A configured
 * expression can name ANY reachable method; one that answers with something
 * other than the `{ checkpointOffset, sink }` handshake is a broken
 * subscription, and the spine should see an ordinary delivery failure
 * (backoff → park), not a crash deeper in the pump.
 */
function parseWakeHandshake(value: unknown): StreamSubscriberWakeResponse {
  const candidate = value as Partial<StreamSubscriberWakeResponse> | null | undefined;
  if (
    // A non-integer/NaN/negative checkpoint from a misbehaving (possibly
    // userspace) wake target would flow into the pump cursor and the
    // watermark row, where NaN binds as SQL NULL and produces a
    // live-looking subscription that silently delivers nothing forever.
    // Reject it here so it surfaces as an ordinary delivery failure
    // (backoff → park).
    !Number.isInteger(candidate?.checkpointOffset) ||
    (candidate!.checkpointOffset as number) < 0 ||
    typeof candidate!.sink !== "function"
  ) {
    throw new Error(
      "wake expression did not resolve to a wake handshake ({ checkpointOffset: int >= 0, sink })",
    );
  }
  return candidate as StreamSubscriberWakeResponse;
}
