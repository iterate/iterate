// Hosts class-based StreamProcessors inside a Durable Object.
//
// The aesthetic this enables:
//
// ```ts
// export class AgentDurableObject extends DurableObject<Env> {
//   host = createStreamProcessorHost(this.ctx);
//   agent = this.host.add("agent", (deps) => new AgentProcessor({ ...deps, openai }));
//   chat = this.host.add("agent-chat", (deps) => new AgentChatProcessor(deps));
//
//   requestStreamSubscription(args: RequestStreamSubscriptionArgs) {
//     return this.host.requestStreamSubscription(args);
//   }
// }
// ```
//
// The Stream DO reaches this entry point by dispatching the Callable stored in
// the stream's `subscription-configured` event; the callable's
// `transformInput.shallowMerge` carries `processorName` so one DO can host any
// number of named processors. On handshake the host retains the live stream
// stub, reads the processor's checkpoint, and calls back `subscribeOutbound` so
// the stream pumps batches into `processor.ingest`.

import type { StreamProcessorSnapshot } from "../stream-processor.ts";
import type { SubscriptionConfiguredEvent } from "../processors/core/contract.ts";
import type { StreamEvent } from "../shared/event.ts";
import type { StreamCoreProcessorState, StreamRpc, StreamSubscriptionHandle } from "../types.ts";

/** What the Stream DO sends when dialing a subscriber's callable. */
export type StreamSubscriptionHandshake = {
  stream: StreamRpc;
  subscriptionKey: string;
  streamMaxOffset: number;
  subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
  streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
};

/**
 * The handshake as received by a host DO's RPC method. `processorName` is
 * normally baked into the subscription's callable via
 * `transformInput.shallowMerge`; it may be omitted when the host has exactly
 * one processor.
 */
export type RequestStreamSubscriptionArgs = StreamSubscriptionHandshake & {
  processorName?: string;
};

/**
 * Base deps the host provides to each processor it owns. Spread them into the
 * processor constructor along with processor-specific deps:
 * `new RepoProcessor({ ...deps, github })`.
 */
export type HostedProcessorDeps = {
  iterateContext: {
    stream: {
      append(args: { streamPath?: string; event: unknown }): unknown;
      appendBatch(args: { streamPath?: string; events: unknown[] }): unknown;
    };
  };
  readState: () => StreamProcessorSnapshot<any> | undefined;
  writeState: (snapshot: StreamProcessorSnapshot<any>) => void;
  sideEffectsAfterOffset: () => number;
  keepAliveWhile: (work: () => Promise<unknown>) => void;
};

export type HostedProcessorRuntimeState = {
  processorName: string;
  snapshot: StreamProcessorSnapshot<unknown> | undefined;
  subscription:
    | { subscriptionKey: string; namespace: string; path: string; sideEffectsAfterOffset: number }
    | undefined;
};

// Structural: the host drives the processor's public surface only. (A
// `StreamProcessor<any, ...>` bound would compare #-private fields nominally
// and reject concrete subclasses over their state types.)
type AnyHostedProcessor = {
  contract: { slug: string; consumes: readonly string[] };
  ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
  snapshot(): Promise<StreamProcessorSnapshot<unknown>>;
};

type HostedEntry = {
  processor: AnyHostedProcessor;
  /** Live stream stub retained across the subscription lifetime. */
  stream: RetainedStreamRpc | undefined;
  handle: StreamSubscriptionHandle | undefined;
  namespace: string | undefined;
  path: string | undefined;
};

export type StreamProcessorHost = {
  /**
   * Register a named processor. The builder receives the host-provided base
   * deps (checkpoint storage in DO KV keyed by `name`, late-bound stream
   * context, the side-effect anchor) and must construct the processor with
   * them. Call during DO field initialization.
   */
  add<P extends AnyHostedProcessor>(name: string, build: (deps: HostedProcessorDeps) => P): P;
  /** Wire this to a public RPC method; subscription callables dial it. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void>;
  /** Durable processor state for tests and operator inspection. */
  runtimeState(processorName?: string): HostedProcessorRuntimeState;
};

export function createStreamProcessorHost(ctx: DurableObjectState): StreamProcessorHost {
  const entries = new Map<string, HostedEntry>();

  const snapshotKey = (name: string) => `stream-processor:${name}:snapshot`;
  const anchorKey = (name: string) => `stream-processor:${name}:side-effects-after-offset`;
  const subscriptionKeyKey = (name: string) => `stream-processor:${name}:subscription-key`;

  function requireEntry(name: string): HostedEntry {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(
        `Unknown stream processor "${name}" on this host (registered: ${[...entries.keys()].join(", ") || "none"})`,
      );
    }
    return entry;
  }

  function requireStream(name: string): StreamRpc {
    const entry = requireEntry(name);
    if (entry.stream === undefined) {
      throw new Error(
        `Stream processor "${name}" has no stream subscription yet; appends are only possible after the stream has dialed this host`,
      );
    }
    return entry.stream;
  }

  function resolveProcessorName(processorName: string | undefined): string {
    if (processorName !== undefined) return processorName;
    if (entries.size === 1) return [...entries.keys()][0]!;
    throw new Error(
      `processorName is required when a host has more than one processor (registered: ${[...entries.keys()].join(", ")})`,
    );
  }

  return {
    add(name, build) {
      if (entries.has(name)) {
        throw new Error(`Stream processor "${name}" is already registered on this host`);
      }
      const processor = build({
        iterateContext: {
          stream: {
            append: (args) => requireStream(name).append(args as never),
            appendBatch: (args) => requireStream(name).appendBatch(args as never),
          },
        },
        readState: () =>
          ctx.storage.kv.get<StreamProcessorSnapshot<any>>(snapshotKey(name)) ?? undefined,
        writeState: (snapshot) => void ctx.storage.kv.put(snapshotKey(name), snapshot),
        sideEffectsAfterOffset: () => ctx.storage.kv.get<number>(anchorKey(name)) ?? 0,
        keepAliveWhile: (work) => void ctx.waitUntil(work()),
      });
      entries.set(name, {
        processor,
        stream: undefined,
        handle: undefined,
        namespace: undefined,
        path: undefined,
      });
      return processor;
    },

    async requestStreamSubscription(args) {
      const name = resolveProcessorName(args.processorName);
      const entry = requireEntry(name);

      // The anchor persists from the FIRST attach: re-handshakes after DO
      // eviction must not move it forward, or side effects for events between
      // the checkpoint and the stream head would be silently dropped.
      if (ctx.storage.kv.get<number>(anchorKey(name)) === undefined) {
        ctx.storage.kv.put(anchorKey(name), args.subscriptionConfiguredEvent.offset);
      }
      ctx.storage.kv.put(subscriptionKeyKey(name), args.subscriptionKey);

      entry.handle?.unsubscribe();
      entry.stream?.[Symbol.dispose]();
      // Workers RPC parameter stubs are disposed when the call returns unless
      // duplicated. Processor side effects may append later, so retain the
      // stream capability until the next handshake replaces it.
      // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
      entry.stream = retainStreamRpc(args.stream);
      entry.namespace = args.streamRuntimeState.coreProcessorState.namespace;
      entry.path = args.streamRuntimeState.coreProcessorState.path;

      const snapshot = await entry.processor.snapshot();
      entry.handle = await (entry.stream as OutboundStreamRpc).subscribeOutbound({
        subscriptionKey: args.subscriptionKey,
        replayAfterOffset: snapshot.offset,
        // The contract is the filter: the stream only delivers event types the
        // processor consumes. A `"*"` in consumes means unfiltered delivery.
        eventTypes: entry.processor.contract.consumes,
        processEventBatch: (batch) => {
          // ingest serializes batches internally; waitUntil keeps the DO alive
          // through blocking side effects after the RPC callback returns.
          const processed = entry.processor.ingest(batch).catch((error: unknown) => {
            console.error(`stream processor "${name}" failed to ingest batch`, error);
          });
          ctx.waitUntil(processed);
          return processed;
        },
      });

      // Announce the processor's contract on the stream (idempotent per
      // slug+version). This replaces the old per-processor
      // standardProcessorBehavior self-registration.
      const contract = entry.processor.contract as {
        slug: string;
        version?: string;
        description?: string;
        consumes: readonly string[];
        emits?: readonly string[];
        events: Record<string, { description?: string }>;
      };
      ctx.waitUntil(
        Promise.resolve(
          entry.stream.append({
            event: {
              type: "events.iterate.com/stream/processor-registered",
              idempotencyKey: `processor-registered:${contract.slug}:${contract.version ?? "0"}`,
              payload: {
                slug: contract.slug,
                version: contract.version ?? "0",
                description: contract.description ?? "",
                consumes: [...contract.consumes],
                emits: [...(contract.emits ?? [])],
                ownedEvents: Object.entries(contract.events).map(([type, definition]) => ({
                  type,
                  ...(definition.description === undefined
                    ? {}
                    : { description: definition.description }),
                })),
              },
            },
          }),
        ).catch((error: unknown) => {
          console.error(`stream processor "${name}" failed to register contract`, error);
        }),
      );
    },

    runtimeState(processorName) {
      const name = resolveProcessorName(processorName);
      const entry = requireEntry(name);
      const subscriptionKey = ctx.storage.kv.get<string>(subscriptionKeyKey(name));
      return {
        processorName: name,
        snapshot: ctx.storage.kv.get<StreamProcessorSnapshot<unknown>>(snapshotKey(name)),
        subscription:
          subscriptionKey === undefined || entry.namespace === undefined || entry.path === undefined
            ? undefined
            : {
                subscriptionKey,
                namespace: entry.namespace,
                path: entry.path,
                sideEffectsAfterOffset: ctx.storage.kv.get<number>(anchorKey(name)) ?? 0,
              },
      };
    },
  };
}

type RetainedStreamRpc = StreamRpc &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

type OutboundStreamRpc = RetainedStreamRpc & {
  subscribeOutbound(
    args: Parameters<StreamRpc["subscribe"]>[0],
  ): ReturnType<StreamRpc["subscribe"]>;
};

type RetainableStreamRpc = StreamRpc &
  Partial<Disposable> & {
    dup?(): RetainedStreamRpc;
  };

function retainStreamRpc(stream: StreamRpc): RetainedStreamRpc {
  const retainable = stream as RetainableStreamRpc;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign(retained, {
    [Symbol.dispose]() {
      dispose?.();
    },
  }) as RetainedStreamRpc;
}
