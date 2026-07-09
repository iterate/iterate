// Hosts class-based StreamProcessors inside a Durable Object.
//
// The aesthetic this enables:
//
// ```ts
// export class AgentDurableObject extends DurableObject<Env> {
//   host = createStreamProcessorHost(this.ctx, { stream });
//   agent = this.host.add((deps) => new AgentProcessor({ ...deps, openai }));
//   search = this.host.add((deps) => new SearchProcessor(deps));
//
//   wakeStreamSubscriber(args: StreamSubscriberWakeRequest) {
//     return this.host.wakeStreamSubscriber(args);
//   }
// }
// ```
//
// This is the subscriber half of the wake handshake, and the whole handshake
// is ONE call: the stream pokes `wakeStreamSubscriber` with serializable
// coordinates, and the host RETURNS the processor's durable checkpoint plus a
// live sink — the same `(batch: StreamEventBatch) => unknown` shape every
// subscriber gives the stream. The stream owns the returned sink (returned-
// stub ownership transfers to the caller), streams one-way batches into it
// from the checkpoint, and pulls each batch's result as its liveness signal.
//
// Everything that used to live here to make a subscribe-BACK handshake safe —
// connection generations, supersede fencing, ingest-failure re-handshakes,
// poison records, the host-side idle timer — is gone, because its job moved
// to structure: the stream initiated the connection, so the stream owns
// replacement; a rejected batch result closes the connection stream-side and
// the spine re-pokes with backoff, replaying from this host's checkpoint
// (ingest is internally serialized and offset-deduped, so overlap between a
// dying sink and its replacement is harmless); sustained failure parks the
// subscription as a durable fact instead of a console line.

import type { Stream } from "../../itx-api.generated.ts";
import type {
  StreamEventBatch,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "./rpc-types.ts";
import type { StreamProcessorRuntimeState, StreamProcessorSnapshot } from "./stream-processor.ts";
import type { ProcessorContractAnnouncement } from "./core-processor-contract.ts";

/**
 * Base deps the host provides to each processor it owns. Spread them into the
 * processor constructor along with processor-specific deps:
 * `new RepoProcessor({ ...deps, github })`.
 */
type HostedProcessorDeps = {
  stream: Stream;
  /** Path of the hosted stream — stamped as provenance on processor appends. */
  path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  projectId: string | null;
  readState: () => StreamProcessorSnapshot<any> | undefined;
  writeState: (snapshot: StreamProcessorSnapshot<any>) => void;
  keepAliveWhile: (work: () => Promise<unknown>) => void;
};

// Structural: the host drives the processor's public surface only. (A
// `StreamProcessor<any, ...>` bound would compare #-private fields nominally
// and reject concrete subclasses over their state types.) Exported because the
// browser mirror runtime (client-libraries/browser/stream-browser-store.ts)
// hosts processors through the same surface.
export type AnyHostedProcessor = {
  contract: {
    slug: string;
    version: string;
    description: string;
    consumes: readonly string[];
    emits: readonly string[];
    events: Record<string, { description?: string; payloadSchema?: unknown }>;
  };
  ingest(args: {
    events: readonly StreamEventBatch["events"][number][];
    streamMaxOffset: number;
  }): Promise<void>;
  snapshot(): Promise<StreamProcessorSnapshot<unknown>>;
  getRuntimeState(): Promise<StreamProcessorRuntimeState<unknown>>;
};

type HostedEntry = {
  processor: AnyHostedProcessor;
  /** Serializes sink batches per processor; ingest also dedupes by offset internally. */
  ingestChain: Promise<void>;
};

type StreamProcessorHost = {
  readonly stream: Stream;
  /**
   * Register a processor under its contract slug. The builder receives the
   * host-provided base deps (checkpoint storage in DO KV keyed by the slug and
   * the host's stable stream capability) and must construct the processor with
   * them. Call during DO field initialization.
   */
  add<P extends AnyHostedProcessor>(build: (deps: HostedProcessorDeps) => P): P;
  /**
   * Wire this to the host DO's wakeStreamSubscriber RPC method. Resolves the
   * poked processor (by the request's `processorSlug`, or the only registered
   * one) and answers with its checkpoint and a fresh sink.
   */
  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse>;
  /**
   * Pull any events the push delivery has not (yet) brought this processor and
   * ingest them now. Call before serving a read that must reflect a write the
   * caller just made (read-your-writes): push delivery is asynchronous. Ingest
   * is checkpoint-filtered and serialized, so racing a live sink is safe.
   * Failures are logged and swallowed — the read then serves the last
   * successfully ingested state, exactly as it would have without the pull.
   */
  catchUp(name: string): Promise<void>;
};

export function createStreamProcessorHost(
  ctx: DurableObjectState,
  options: { stream: Stream; path: string; projectId: string | null },
): StreamProcessorHost {
  const entries = new Map<string, HostedEntry>();

  const snapshotKey = (name: string) => `stream-processor:${name}:snapshot`;

  function requireEntry(name: string): HostedEntry {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(
        `Unknown stream processor "${name}" on this host (registered: ${[...entries.keys()].join(", ") || "none"})`,
      );
    }
    return entry;
  }

  function resolveProcessorName(args: StreamSubscriberWakeRequest): string {
    if (args.processorSlug !== undefined) {
      requireEntry(args.processorSlug);
      return args.processorSlug;
    }
    if (entries.size === 1) return [...entries.keys()][0]!;
    throw new Error(
      `wakeStreamSubscriber for "${args.subscriptionKey}" needs a processorSlug on a multi-processor host (registered: ${[...entries.keys()].join(", ")})`,
    );
  }

  return {
    stream: options.stream,
    add(build) {
      // The registry name is the processor's contract slug, which only exists
      // after the builder runs; the checkpoint-storage deps close over it
      // lazily (they are first called on the first snapshot/ingest, long after
      // registration completes).
      let registeredSlug: string | undefined;
      const slug = () => {
        if (registeredSlug === undefined) {
          throw new Error("Stream processor checkpoint storage used before registration");
        }
        return registeredSlug;
      };
      const processor = build({
        stream: options.stream,
        path: options.path,
        projectId: options.projectId,
        readState: () =>
          ctx.storage.kv.get<StreamProcessorSnapshot<any>>(snapshotKey(slug())) ?? undefined,
        writeState: (snapshot) => void ctx.storage.kv.put(snapshotKey(slug()), snapshot),
        keepAliveWhile: (work) => void ctx.waitUntil(work()),
      });
      if (entries.has(processor.contract.slug)) {
        throw new Error(
          `Stream processor "${processor.contract.slug}" is already registered on this host`,
        );
      }
      registeredSlug = processor.contract.slug;
      entries.set(registeredSlug, { processor, ingestChain: Promise.resolve() });
      return processor;
    },

    async catchUp(name) {
      const entry = requireEntry(name);
      try {
        const { offset } = await entry.processor.snapshot();
        using pager = options.stream.readEvents({ afterOffset: offset, limit: 500 });
        for (;;) {
          const events = await pager.next();
          if (events.length === 0) return;
          // Non-consumed event types reduce to no-ops but still advance the
          // checkpoint, mirroring what a filtered delivery's cursor does.
          await entry.processor.ingest({
            events,
            streamMaxOffset: events.at(-1)!.offset,
          });
        }
      } catch (error) {
        console.error(
          `stream processor "${name}" catch-up failed; serving last ingested state`,
          error,
        );
      }
    },

    async wakeStreamSubscriber(args) {
      const name = resolveProcessorName(args);
      const entry = requireEntry(name);
      const snapshot = await entry.processor.snapshot();

      // The sink: the one shape every subscriber gives the stream. Batches are
      // serialized per processor; each batch's promise is RETURNED so the
      // stream's result-pull observes ingest failures (its liveness signal —
      // a rejection closes the connection and the spine re-pokes, replaying
      // from this processor's checkpoint). The chain itself swallows the
      // rejection so one failed batch never wedges the batches behind it.
      const sink = (batch: StreamEventBatch) => {
        const attempt = entry.ingestChain.then(() =>
          entry.processor.ingest({ events: batch.events, streamMaxOffset: batch.streamMaxOffset }),
        );
        entry.ingestChain = attempt.catch((error: unknown) => {
          console.error(`stream processor "${name}" failed to ingest batch`, error);
        });
        // waitUntil keeps the DO alive through ingest after the RPC callback returns.
        ctx.waitUntil(entry.ingestChain);
        return attempt;
      };

      return {
        checkpointOffset: snapshot.offset,
        sink,
        subscriber: {
          processor: { announcement: announceContract(entry.processor.contract) },
        },
        getRuntimeState: () => entry.processor.getRuntimeState(),
      };
    },
  };
}

/**
 * Serializable contract announcement carried on a poke response (and from
 * there onto the subscription's connected presence fact). Shared by this
 * Durable Object host and the browser mirror runtime so both kinds of hosted
 * processor land identically on the stream's presence roster.
 */
export function announceContract(contract: {
  slug: string;
  version: string;
  description: string;
  consumes: readonly string[];
  emits: readonly string[];
  events: Record<string, { description?: string; payloadSchema?: unknown }>;
}): ProcessorContractAnnouncement {
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: [...contract.consumes],
    emits: [...contract.emits],
    ownedEvents: Object.entries(contract.events).map(([type, definition]) => ({
      type,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })),
  };
}
