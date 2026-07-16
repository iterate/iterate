import type {
  GetProcessorRuntimeState,
  StreamEventBatch,
  StreamPingInput,
  StreamSubscriberPing,
} from "./rpc-types.ts";
import type { ProcessorContractAnnouncement } from "./core-processor-contract.ts";
import type { SubscriberMetrics } from "./subscriber-metrics.ts";
import type { StreamProcessorRuntimeState, StreamProcessorSnapshot } from "./stream-processor.ts";

/** The processor surface shared by Durable Object and browser hosts. */
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
    /** Raw-log interval the transport scanned, including empty filtered ranges. */
    scannedAfterOffset: number;
    scannedThroughOffset: number;
  }): Promise<void>;
  snapshot(): Promise<StreamProcessorSnapshot<unknown>>;
  getRuntimeState(): Promise<StreamProcessorRuntimeState<unknown>>;
  currentState: unknown;
  readonly isLoaded: boolean;
  readonly subscriberMetrics: Pick<
    SubscriberMetrics,
    "report" | "notePingObserved" | "noteAppendCommitted" | "clearPendingAppends"
  >;
  markLoaded(): void;
  observeStateChanges(observer: (snapshot: StreamProcessorSnapshot<unknown>) => void): () => void;
};

/**
 * The two live capabilities every processor host hands the stream alongside
 * its sink, shared by the server host and browser runtime so they cannot drift.
 */
export function hostRuntimeCapabilities(
  processor: AnyHostedProcessor,
  opts: { now: () => number; oneWayEstimateMs?: () => number | undefined },
): { getRuntimeState: GetProcessorRuntimeState; ping: StreamSubscriberPing } {
  return {
    getRuntimeState: async () => {
      const state = await processor.getRuntimeState();
      const metrics = processor.subscriberMetrics.report();
      return { ...state, runtime: { ...state.runtime, metrics } };
    },
    ping: (input: StreamPingInput) => {
      const t1 = opts.now();
      const oneWayEstimateMs = opts.oneWayEstimateMs?.();
      if (oneWayEstimateMs !== undefined) {
        processor.subscriberMetrics.notePingObserved({ t0: input.t0, t1, oneWayEstimateMs });
      }
      return { t0: input.t0, t1, t2: opts.now() };
    },
  };
}

/** Serializable processor contract carried by server and browser hosts. */
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
