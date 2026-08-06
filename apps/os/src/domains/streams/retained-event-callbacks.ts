// Workers RPC capabilities normally live only for the call that carried them.
// A stream connection must keep processEventBatch, runtime-state, and ping
// callbacks alive until that connection closes, then release them exactly once.

import { disposeIgnoredRpcResult, isThenable, retainCallback } from "iterate/sdk/capnweb";
import { z } from "zod";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  ProcessorRuntimeState,
  StreamConnectionPing,
  StreamEventBatch,
  StreamPingInput,
  StreamPingReply,
  StreamProcessorWakeResponse,
  StreamWakeEventBatch,
} from "iterate/processors";

/** A retained fire-and-forget event callback with connection-lifetime cleanup. */
export type RetainedProcessEventBatch<
  Batch extends StreamEventBatch = Parameters<ProcessEventBatch>[0],
> = ((batch: Batch) => void) &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

/**
 * Retain a processEventBatch callback after the RPC call that supplied it ends.
 *
 * Its result is always disposed without being awaited. A hosted processor can
 * append back to the stream that called it, so awaiting the result can make
 * two Durable Objects wait for each other forever. Hosted batches report their
 * eventual result through `StreamWakeEventBatch.reportDeliveryResult`;
 * `onDeliveryError` covers only a synchronous dead-stub throw.
 */
export function retainProcessEventBatch<Batch extends StreamEventBatch>(
  processEventBatch: (batch: Batch) => unknown,
  opts: {
    onDeliveryError?: (error: unknown) => void;
    onDisposed?: () => void;
  } = {},
): RetainedProcessEventBatch<Batch> {
  const retained = retainCallback<Batch>(processEventBatch);
  const onDeliveryError = opts.onDeliveryError;
  const callback: RetainedProcessEventBatch<Batch> = Object.assign(
    (batch: Batch) => {
      let result: unknown;
      try {
        result = retained(batch);
      } catch (error) {
        onDeliveryError?.(error);
        return;
      }
      disposeIgnoredRpcResult(result);
    },
    {
      [Symbol.dispose]() {
        try {
          retained[Symbol.dispose]();
        } finally {
          opts.onDisposed?.();
        }
      },
    },
  );
  if (retained.onRpcBroken) callback.onRpcBroken = retained.onRpcBroken;
  return callback;
}

/** Retain a request/response callback and dispose each returned RPC value after it is pulled. */
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

/** Retain a hosted processor's runtime-state callback for one connection. */
export function retainGetProcessorRuntimeState(
  getRuntimeState: GetProcessorRuntimeState | undefined,
): (GetProcessorRuntimeState & Disposable) | undefined {
  const retained = retainPulledCall<void, ProcessorRuntimeState>(getRuntimeState);
  if (retained === undefined) return undefined;
  return Object.assign(() => retained(undefined), {
    [Symbol.dispose]: () => retained[Symbol.dispose](),
  });
}

/** A retained ping callback, disposed when its connection closes. */
export type RetainedConnectionPing = ((
  input: StreamPingInput,
) => StreamPingReply | Promise<StreamPingReply>) &
  Disposable;

/** Retain a connection owner's ping callback for one connection. */
export function retainConnectionPing(
  ping: StreamConnectionPing | undefined,
): RetainedConnectionPing | undefined {
  return retainPulledCall<StreamPingInput, StreamPingReply>(ping);
}

/**
 * A client connection's capability dispatch door: the relay-side function that
 * replays one dotted path onto the connection owner's live capabilities
 * target. `itx.clients.get(path).capabilities.*` calls arrive here.
 */
export type InvokeClientCapability = (input: {
  path: string[];
  args: unknown[];
}) => unknown | Promise<unknown>;

/** A retained capability dispatch door, disposed when its connection closes. */
export type RetainedInvokeClientCapability = ((input: {
  path: string[];
  args: unknown[];
}) => unknown | Promise<unknown>) &
  Disposable;

/** Retain a client connection's capability dispatch door for one connection. */
export function retainInvokeClientCapability(
  invoke: InvokeClientCapability | undefined,
): RetainedInvokeClientCapability | undefined {
  return retainPulledCall<{ path: string[]; args: unknown[] }, unknown>(invoke);
}

export type RetainedProcessorWakeResponse = {
  streamId: string;
  checkpointOffset: number;
  processEventBatch: RetainedProcessEventBatch<StreamWakeEventBatch>;
  openedBy?: unknown;
  getRuntimeState?: GetProcessorRuntimeState & Disposable;
  ping?: RetainedConnectionPing;
};

/**
 * Take ownership of all RPC capabilities returned by wakeStreamProcessor and
 * tie their lifetime to the retained processEventBatch callback.
 */
export function retainProcessorWakeResponse(args: {
  value: unknown;
  onDeliveryError: (error: unknown) => void;
}): RetainedProcessorWakeResponse {
  let originalReleased = false;
  const releaseOriginal = () => {
    if (originalReleased) return;
    originalReleased = true;
    disposeIgnoredRpcResult(args.value);
  };

  let getRuntimeState: (GetProcessorRuntimeState & Disposable) | undefined;
  let ping: RetainedConnectionPing | undefined;
  let processEventBatch: RetainedProcessEventBatch<StreamWakeEventBatch> | undefined;
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
    const response = parseProcessorWakeResponse(args.value);
    getRuntimeState = retainGetProcessorRuntimeState(response.getRuntimeState);
    ping = retainConnectionPing(response.ping);
    processEventBatch = retainProcessEventBatch(response.processEventBatch, {
      onDeliveryError: args.onDeliveryError,
      onDisposed: releaseRetained,
    });
    releaseOriginal();
    ownershipTransferred = true;
    return {
      streamId: response.streamId,
      checkpointOffset: response.checkpointOffset,
      processEventBatch,
      openedBy: response.openedBy,
      getRuntimeState,
      ping,
    };
  } finally {
    if (!ownershipTransferred) {
      try {
        if (processEventBatch === undefined) releaseRetained();
        else processEventBatch[Symbol.dispose]();
      } finally {
        releaseOriginal();
      }
    }
  }
}

/** Reject malformed wake responses before their values reach cursor state. */
function parseProcessorWakeResponse(value: unknown): StreamProcessorWakeResponse {
  const candidate = value as Partial<StreamProcessorWakeResponse> | null | undefined;
  if (
    !z.uuid().safeParse(candidate?.streamId).success ||
    !Number.isInteger(candidate?.checkpointOffset) ||
    (candidate!.checkpointOffset as number) < 0 ||
    typeof candidate!.processEventBatch !== "function"
  ) {
    throw new Error(
      "wakeStreamProcessor did not return { streamId: UUID, checkpointOffset: int >= 0, processEventBatch }",
    );
  }
  return candidate as StreamProcessorWakeResponse;
}
