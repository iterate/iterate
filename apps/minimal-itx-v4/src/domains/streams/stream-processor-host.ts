// Hosts class-based StreamProcessors inside a Durable Object.
//
// The aesthetic this enables:
//
// ```ts
// export class AgentDurableObject extends DurableObject<Env> {
//   host = createStreamProcessorHost(this.ctx, { stream });
//   agent = this.host.add("agent", (deps) => new AgentProcessor({ ...deps, openai }));
//   search = this.host.add("search", (deps) => new SearchProcessor(deps));
//
//   wakeStreamSubscriber(args: StreamSubscriberWakeRequest) {
//     return this.host.wakeStreamSubscriber(args);
//   }
// }
// ```
//
// The Stream DO reaches this entry point from a configured subscriber target.
// On wake, the host reads the processor's checkpoint and subscribes with its
// own stable stream capability, so the stream pumps batches into
// `processor.ingest`.

import type {
  ProcessEventBatch,
  Stream,
  StreamEvent,
  StreamSubscriptionHandle,
} from "../../types.ts";
import type { StreamProcessorRuntimeState, StreamProcessorSnapshot } from "./stream-processor.ts";
import type { ProcessorContractAnnouncement } from "./core-processor-contract.ts";

type ConfiguredStream = Stream & {
  subscribeConfigured(input: {
    subscriptionKey: string;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    eventTypes?: readonly string[];
    events?: boolean;
    subscriber?: unknown;
  }): Promise<StreamSubscriptionHandle>;
};

/** What the Stream DO sends when asking a hosted processor to subscribe back. */
export type StreamSubscriberWakeRequest = {
  stream: {
    projectId: string | null;
    path: string;
    streamMaxOffset: number;
  };
  subscriptionKey: string;
};

/**
 * Base deps the host provides to each processor it owns. Spread them into the
 * processor constructor along with processor-specific deps:
 * `new RepoProcessor({ ...deps, github })`.
 */
type HostedProcessorDeps = {
  stream: ConfiguredStream;
  readState: () => StreamProcessorSnapshot<any> | undefined;
  writeState: (snapshot: StreamProcessorSnapshot<any>) => void;
  keepAliveWhile: (work: () => Promise<unknown>) => void;
};

// Structural: the host drives the processor's public surface only. (A
// `StreamProcessor<any, ...>` bound would compare #-private fields nominally
// and reject concrete subclasses over their state types.)
type AnyHostedProcessor = {
  contract: {
    slug: string;
    version?: string;
    description?: string;
    consumes: readonly string[];
    emits?: readonly string[];
    events: Record<string, { description?: string; payloadSchema?: unknown }>;
  };
  ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
  snapshot(): Promise<StreamProcessorSnapshot<unknown>>;
  getRuntimeState(): Promise<StreamProcessorRuntimeState<unknown>>;
};

type HostedEntry = {
  processor: AnyHostedProcessor;
  handle: StreamSubscriptionHandle | undefined;
  /** Consecutive ingest failures since the last successful batch. */
  consecutiveIngestFailures: number;
  /**
   * Bumped on every (re)subscription. Batches delivered on a superseded
   * generation are dropped instead of ingested — see the gate in
   * `openSubscription`.
   */
  generation: number;
  /** Serializes ingest per processor so the generation gate is re-checked between batches. */
  ingestChain: Promise<void>;
};

// A failed batch does not advance the checkpoint, so we re-handshake from it and
// the stream replays the batch — this recovers transient failures. A batch that
// keeps failing is poison: after this many consecutive failures we stop retrying,
// record a stream/error-occurred event, and disconnect, leaving it to the
// subscriber/processor (or a later wake) to decide whether to re-establish.
const MAX_CONSECUTIVE_INGEST_FAILURES = 3;

// Belt-and-braces companion to the Stream DO's idle teardown. A live subscription
// handle pins the delivery connection. If no batch arrives for this long, the
// host unsubscribes so this subscriber DO and the producer can hibernate; the
// durable checkpoint + subscription-key persist, so the producer re-wakes us and
// the host re-handshakes when activity resumes. In-memory timer for the same
// reason as the Stream DO side: a durable alarm's only extra power — waking a
// hibernated DO — is exactly wrong.
const HOST_IDLE_TEARDOWN_MS = 5 * 60_000;

type StreamProcessorHost = {
  readonly stream: ConfiguredStream;
  /**
   * Register a named processor. The builder receives the host-provided base
   * deps (checkpoint storage in DO KV keyed by `name` and the host's stable
   * stream capability) and must construct the processor with them. Call during
   * DO field initialization.
   */
  add<P extends AnyHostedProcessor>(name: string, build: (deps: HostedProcessorDeps) => P): P;
  /** Wire this to the host DO's wakeStreamSubscriber RPC method. */
  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void>;
  /**
   * Drop every live subscription now — the idle timer's action, also exposed
   * directly for tests / operator "let this idle subscriber sleep". The durable
   * checkpoint + subscription-key persist, so the producer re-wakes this
   * host re-handshakes on the next activity.
   */
  runIdleDisconnectNow(): void;
};

export function createStreamProcessorHost(
  ctx: DurableObjectState,
  options: { stream: ConfiguredStream },
): StreamProcessorHost {
  const entries = new Map<string, HostedEntry>();

  // One id per host DO instance. It rides on each subscription's
  // subscriber-connected presence fact: a connected event with a new
  // incarnationId tells every reconciling processor that this host's
  // non-serializable runtime state (timers, in-flight requests, sockets)
  // was reset.
  const hostIncarnationId = crypto.randomUUID();

  const snapshotKey = (name: string) => `stream-processor:${name}:snapshot`;
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

  function resolveProcessorName(subscriptionKey: string): string {
    if (entries.size === 1) return [...entries.keys()][0]!;
    const suffix = subscriptionKey.split("#").at(-1);
    if (suffix !== undefined && entries.has(suffix)) return suffix;
    throw new Error(
      `wakeStreamSubscriber could not resolve processor for subscription "${subscriptionKey}" (registered: ${[...entries.keys()].join(", ")})`,
    );
  }

  // In-memory idle teardown: unsubscribe after a quiet spell so this subscriber
  // DO (and the producer connection it pins) can hibernate. See HOST_IDLE_TEARDOWN_MS.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function hasLiveSubscription(): boolean {
    for (const entry of entries.values()) if (entry.handle !== undefined) return true;
    return false;
  }

  // (Re)armed on every handshake and every delivered batch; cleared once no
  // entry holds a live subscription handle.
  function armIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (!hasLiveSubscription()) return;
    idleTimer = setTimeout(runIdleDisconnectNow, HOST_IDLE_TEARDOWN_MS);
  }

  function runIdleDisconnectNow(): void {
    idleTimer = undefined;
    for (const entry of entries.values()) {
      const handle = entry.handle;
      if (handle === undefined) continue;
      // Bump the generation so any batch still queued on this connection is
      // dropped by the gate in openSubscription. Then unsubscribe; the durable
      // checkpoint + subscription-key persist, so the producer's next wake
      // re-handshakes us from where we left off.
      entry.generation += 1;
      try {
        handle.unsubscribe();
      } catch {
        // The producer may already be gone; the handle is dead either way.
      }
      entry.handle = undefined;
    }
  }

  // (Re)opens the configured subscription from the processor's durable checkpoint.
  // Called for the initial handshake and again by `recoverFromIngestFailure`, so
  // a failed batch replays from the last good offset instead of being skipped.
  async function openSubscription(name: string): Promise<void> {
    const entry = requireEntry(name);
    const subscriptionKey = ctx.storage.kv.get<string>(subscriptionKeyKey(name));
    if (subscriptionKey === undefined) {
      throw new Error(`Stream processor "${name}" has no stored subscription key`);
    }
    // Each (re)subscription is a generation. The pump is fire-and-forget, so
    // while a failed batch recovers the stream keeps delivering later batches;
    // ingesting one of those would advance the checkpoint past the failed offset
    // and lose it. Capturing the generation and dropping batches from a
    // superseded connection makes the post-recovery replay the single source of
    // truth.
    const generation = entry.generation;
    const snapshot = await entry.processor.snapshot();
    entry.handle = await options.stream.subscribeConfigured({
      subscriptionKey,
      replayAfterOffset: snapshot.offset,
      // The contract is the filter: the stream only delivers event types the
      // processor consumes. A `"*"` in consumes means unfiltered delivery.
      eventTypes: entry.processor.contract.consumes,
      // The stream appends this identity as a subscriber-connected presence
      // fact; the contract announcement feeds its processorsBySlug registry.
      // Recovery re-subscriptions pass the same incarnationId — each (re)open
      // genuinely is a new connection and re-lands on the roster.
      subscriber: {
        incarnationId: hostIncarnationId,
        processor: {
          announcement: announceContract(entry.processor.contract),
          getRuntimeState: () => entry.processor.getRuntimeState(),
        },
      },
      processEventBatch: (batch) => {
        // A batch arrived — this subscription is active; reset the idle countdown.
        armIdleTimer();
        // Serialize ingest per processor so the generation gate is re-checked
        // *between* batches: a batch queued on a now-dead connection must be
        // dropped, not ingested. ingest serializes internally too, but that
        // can't drop a batch that was already accepted.
        entry.ingestChain = entry.ingestChain
          .then(async () => {
            if (generation !== entry.generation) return; // superseded connection; replay covers it
            try {
              await entry.processor.ingest(batch);
              entry.consecutiveIngestFailures = 0;
            } catch (error) {
              await recoverFromIngestFailure(name, error);
            }
          })
          // Recovery itself can throw (e.g. the re-handshake or the poison-path
          // error append fails). Never let that leave the chain rejected, or every
          // later batch's `.then` would be skipped and delivery would wedge. A
          // future re-handshake (stream-side reconcile) is the way back.
          .catch((error: unknown) => {
            console.error(`stream processor "${name}" ingest recovery failed`, error);
          });
        // waitUntil keeps the DO alive through ingest + recovery after the RPC
        // callback returns.
        ctx.waitUntil(entry.ingestChain);
        return entry.ingestChain;
      },
    });
    // A fresh handshake opened a live subscription; start the idle countdown.
    armIdleTimer();
  }

  // A failed batch never advances the checkpoint. Re-handshake from it (the
  // stream replays the batch) to recover transient failures; give up and
  // disconnect once a batch proves poison.
  async function recoverFromIngestFailure(name: string, error: unknown): Promise<void> {
    const entry = requireEntry(name);
    entry.consecutiveIngestFailures += 1;
    console.error(
      `stream processor "${name}" failed to ingest batch (attempt ${entry.consecutiveIngestFailures})`,
      error,
    );

    // Invalidate the current connection so its already-delivered batches are
    // dropped by the generation gate, then tear it down.
    entry.generation += 1;
    entry.handle?.unsubscribe();
    entry.handle = undefined;

    if (entry.consecutiveIngestFailures <= MAX_CONSECUTIVE_INGEST_FAILURES) {
      // Transient: re-handshake from the durable checkpoint; the stream replays
      // the failed batch (replay is idempotent — events <= checkpoint filter out).
      await openSubscription(name);
      return;
    }

    // Poison batch: stop retrying, record the failure on the stream, and stay
    // disconnected. It is up to the subscriber/processor (or a later wake) to
    // decide whether to re-establish the subscription.
    const offset = (await entry.processor.snapshot()).offset;
    const message = (error instanceof Error ? error.message : String(error)) || "unknown error";
    await options.stream.append({
      type: "events.iterate.com/stream/error-occurred",
      idempotencyKey: `processor-ingest-failed:${name}:${offset}`,
      payload: {
        message: `stream processor "${name}" gave up after ${entry.consecutiveIngestFailures} failed ingest attempts at offset ${offset}`,
        error: {
          message,
          ...(error instanceof Error && error.name ? { name: error.name } : {}),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      },
    });
  }

  return {
    stream: options.stream,
    add(name, build) {
      if (entries.has(name)) {
        throw new Error(`Stream processor "${name}" is already registered on this host`);
      }
      const processor = build({
        stream: options.stream,
        readState: () =>
          ctx.storage.kv.get<StreamProcessorSnapshot<any>>(snapshotKey(name)) ?? undefined,
        writeState: (snapshot) => void ctx.storage.kv.put(snapshotKey(name), snapshot),
        keepAliveWhile: (work) => void ctx.waitUntil(work()),
      });
      entries.set(name, {
        processor,
        handle: undefined,
        consecutiveIngestFailures: 0,
        generation: 0,
        ingestChain: Promise.resolve(),
      });
      return processor;
    },

    async wakeStreamSubscriber(args) {
      const name = resolveProcessorName(args.subscriptionKey);
      const entry = requireEntry(name);

      ctx.storage.kv.put(subscriptionKeyKey(name), args.subscriptionKey);

      entry.handle?.unsubscribe();
      // Invalidate the previous connection (same as recoverFromIngestFailure):
      // this handshake replaces it, so any batch still queued on it must be
      // dropped by the generation gate — the new connection's replay from the
      // checkpoint is authoritative.
      entry.generation += 1;
      entry.handle = undefined;
      entry.consecutiveIngestFailures = 0;

      await openSubscription(name);
    },

    runIdleDisconnectNow,
  };
}

function announceContract(contract: {
  slug: string;
  version?: string;
  description?: string;
  consumes: readonly string[];
  emits?: readonly string[];
  events: Record<string, { description?: string; payloadSchema?: unknown }>;
}): ProcessorContractAnnouncement {
  return {
    slug: contract.slug,
    version: contract.version ?? "0",
    description: contract.description ?? "",
    consumes: [...contract.consumes],
    emits: [...(contract.emits ?? [])],
    ownedEvents: Object.entries(contract.events).map(([type, definition]) => ({
      type,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })),
  };
}
