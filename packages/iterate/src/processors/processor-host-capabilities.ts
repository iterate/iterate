import type { z } from "zod";
import type {
  GetProcessorRuntimeState,
  ProcessorSnapshot,
  StreamPingInput,
  StreamConnectionPing,
} from "./rpc-types.ts";
import type { ProcessorContractAnnouncement } from "./processor-contracts.ts";
import type { EventConsumptionMetrics } from "./event-consumption-metrics.ts";
import type { ProcessorRuntimeContribution } from "./stream-processor.ts";

/**
 * The processor surface shared by the Durable Object registry
 * (stream-processor-registry.ts) and the browser host (stream-browser-store.ts):
 * the contract description returned by `wakeStreamProcessor`, the
 * processor-contributed runtime bag, and self-measured event-consumption metrics.
 * Deliberately NOT the drive surface — cursors, snapshots, and delivery live
 * in the StreamProcessorRunner, which reaches the protected hooks through
 * `StreamProcessor.runnerHooks`.
 */
export type AnyHostedProcessor = {
  contract: {
    slug: string;
    version: string;
    description: string;
    stateSchema: z.ZodType;
    consumes: readonly string[];
    emits: readonly string[];
    events: Record<string, { description?: string; payloadSchema?: unknown }>;
  };
  /** The processor-contributed runtime bag; the snapshot half comes from the runner. */
  getRuntimeState(): Promise<ProcessorRuntimeContribution>;
  readonly eventConsumptionMetrics: Pick<
    EventConsumptionMetrics,
    "report" | "notePingObserved" | "noteAppendCommitted" | "clearPendingAppends"
  >;
};

/**
 * The two live capabilities every processor host hands the stream alongside
 * its event-batch callback, shared by the DO registry and browser runtime so they cannot
 * drift. `getRuntimeState` assembles the published shape from its two honest
 * sources: the SNAPSHOT from the runner (`opts.snapshot` — the cursor owner),
 * the `runtime` bag from the processor, with the self-measured metrics merged
 * in host-side so a subclass override cannot accidentally drop them.
 */
export function hostRuntimeCapabilities(
  processor: AnyHostedProcessor,
  opts: {
    now: () => number;
    /** The driving runner's committed snapshot (`() => runner.snapshot()`). */
    snapshot: () => Promise<ProcessorSnapshot<unknown>>;
    oneWayEstimateMs?: () => number | undefined;
  },
): { getRuntimeState: GetProcessorRuntimeState; ping: StreamConnectionPing } {
  return {
    getRuntimeState: async () => {
      const contributed = await processor.getRuntimeState();
      const metrics = processor.eventConsumptionMetrics.report();
      return {
        snapshot: await opts.snapshot(),
        runtime: { ...contributed.runtime, metrics },
      };
    },
    ping: (input: StreamPingInput) => {
      const t1 = opts.now();
      const oneWayEstimateMs = opts.oneWayEstimateMs?.();
      if (Number.isFinite(oneWayEstimateMs)) {
        processor.eventConsumptionMetrics.notePingObserved({ t0: input.t0, t1, oneWayEstimateMs });
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
      ...(!definition.description ? {} : { description: definition.description }),
    })),
  };
}
