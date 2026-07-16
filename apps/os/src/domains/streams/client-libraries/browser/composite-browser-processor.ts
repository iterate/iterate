// The browser stream mirror hosts ONE processor over ONE download. When a
// stream needs more than one local projection (the verbatim event cache AND the
// feed_items projection), they are fanned out from that single download by this
// composite: it satisfies the same `AnyHostedProcessor` surface the runtime
// already drives, so the runtime stays single-processor and none of its
// race-critical machinery (connection epochs, catch-up pager, liveness probe,
// ingest self-heal) has to learn about processor lists.
//
// Why fan-out is safe: every child is a StreamProcessor, and StreamProcessor
// skips events at or below its own checkpoint before doing any projection work
// (stream-processor.ts #ingest). So a child that is already ahead of the shared
// replay cursor cheaply no-ops on the events it has seen, and the runtime can
// drive all children from the SAME batch stream.

import type { AgentUiState } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { AnyHostedProcessor } from "../../processor-host-capabilities.ts";
import type {
  StreamProcessorRuntimeState,
  StreamProcessorSnapshot,
} from "../../stream-processor.ts";

/** A canonical mirror member: its stable slug and the hosted processor instance. */
type CompositeChild = { slug: string; processor: AnyHostedProcessor };

/**
 * Fans the single mirror download out to an ordered set of child processors.
 * The first child is the PRIMARY: it bears the reported subscriber metrics
 * (see {@link subscriberMetrics}) and should be the one that mirrors every
 * appended event (the raw-events cache), so the consume-own-append loop the
 * runtime feeds actually closes.
 */
export class CompositeBrowserProcessor implements AnyHostedProcessor {
  readonly contract: AnyHostedProcessor["contract"];
  readonly #children: readonly CompositeChild[];
  readonly #primary: AnyHostedProcessor;

  constructor(children: readonly CompositeChild[]) {
    if (children.length === 0) {
      throw new Error("CompositeBrowserProcessor requires at least one child processor");
    }
    this.#children = children;
    this.#primary = children[0].processor;

    // Announce a single synthetic mirror contract to the server subscription.
    // consumes/emits are the union of the members' — both canonical members
    // consume "*", so the one subscription still delivers every event each
    // child needs.
    const consumes = new Set<string>();
    const emits = new Set<string>();
    let events: Record<string, { description?: string; payloadSchema?: unknown }> = {};
    for (const { processor } of children) {
      for (const type of processor.contract.consumes) consumes.add(type);
      for (const type of processor.contract.emits) emits.add(type);
      events = { ...events, ...processor.contract.events };
    }
    this.contract = {
      slug: "browser-stream-mirror",
      version: "0.1.0",
      description: "Fans the browser stream mirror download out to its canonical processors.",
      consumes: [...consumes],
      emits: [...emits],
      events,
    };
  }

  /**
   * Metrics are delegated to the primary (raw-events) member rather than
   * aggregated: the runtime feeds `noteAppendCommitted` here and the loop closes
   * when the appended offset is ingested — and every appended event lands in the
   * raw-events cache, so the primary's own `noteBatchIngested` closes it
   * honestly. This measures append→cached latency; the feed fold that runs
   * immediately after is a sub-millisecond local step.
   */
  get subscriberMetrics(): AnyHostedProcessor["subscriberMetrics"] {
    return this.#primary.subscriberMetrics;
  }

  get currentState(): unknown {
    return this.#primary.currentState;
  }

  get isLoaded(): boolean {
    return this.#children.every(({ processor }) => processor.isLoaded);
  }

  async ingest(args: Parameters<AnyHostedProcessor["ingest"]>[0]): Promise<void> {
    // Sequential, in canonical order (raw cache first). The children share one
    // OPFS SQLite connection, so parallel `sql.batch(..., {transaction:true})`
    // calls would interleave; and a rejecting `Promise.all` would abandon a
    // sibling mid-write, re-creating the abandoned-ingest hazard the pager
    // avoids. A child that throws propagates so the runtime's self-heal
    // resubscribes from the (new minimum) checkpoint and replays for every
    // child — each child's own idempotency (raw-events' RAISE(IGNORE), feed's
    // ON CONFLICT) makes that replay safe.
    const durableArgs = {
      ...args,
      events: args.events.filter((event) => event.ephemeral !== true),
    };
    for (const { processor } of this.#children) {
      if (isLiveAgentProcessor(processor)) {
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- children share one SQLite connection and must commit in canonical order; see the contract above.
        await processor.ingestLive(args);
      } else {
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- children share one SQLite connection and must commit in canonical order; see the contract above.
        await processor.ingest(durableArgs);
      }
    }
  }

  /**
   * Fan out a server range-read page. Raw-event mirrors get an explicit sparse
   * lane because omitted historical ephemerals leave legitimate offset gaps;
   * all other projections ingest the same durable page normally.
   */
  async ingestHistorical(args: Parameters<AnyHostedProcessor["ingest"]>[0]): Promise<void> {
    for (const { processor } of this.#children) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- children share one SQLite connection and must commit in canonical order; see ingest() above.
      await processor.ingest(args);
    }
  }

  /** Current in-memory live agent tail, when the feed child exposes one. */
  get agentUiState(): AgentUiState | null {
    for (const { processor } of this.#children) {
      if (isLiveAgentProcessor(processor)) return processor.agentUiState;
    }
    return null;
  }

  clearVolatileState(): void {
    for (const { processor } of this.#children) {
      if (isLiveAgentProcessor(processor)) processor.clearVolatileState();
    }
  }

  async snapshot(): Promise<StreamProcessorSnapshot<unknown>> {
    // The runtime uses this offset as the replay cursor for catch-up and the
    // live subscription. Take the MINIMUM across children so replay covers the
    // least-caught-up member; members already past it re-receive events they
    // have and no-op. `state` is unused by the runtime for the hosted
    // processor (only `.offset` is read).
    const snapshots = await Promise.all(
      this.#children.map(({ processor }) => processor.snapshot()),
    );
    const offset = snapshots.reduce(
      (min, snapshot) => Math.min(min, snapshot.offset),
      Number.POSITIVE_INFINITY,
    );
    return { offset: Number.isFinite(offset) ? offset : 0, state: null };
  }

  async getRuntimeState(): Promise<StreamProcessorRuntimeState<unknown>> {
    return { snapshot: await this.snapshot() };
  }

  markLoaded(): void {
    for (const { processor } of this.#children) processor.markLoaded();
  }

  observeStateChanges(observer: (snapshot: StreamProcessorSnapshot<unknown>) => void): () => void {
    const unsubscribes = this.#children.map(({ processor }) =>
      processor.observeStateChanges(observer),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }
}

type LiveAgentProcessor = AnyHostedProcessor & {
  ingestLive: (args: Parameters<AnyHostedProcessor["ingest"]>[0]) => Promise<void>;
  readonly agentUiState: AgentUiState;
  clearVolatileState: () => void;
};

function isLiveAgentProcessor(processor: AnyHostedProcessor): processor is LiveAgentProcessor {
  return (
    "ingestLive" in processor &&
    typeof processor.ingestLive === "function" &&
    "agentUiState" in processor &&
    "clearVolatileState" in processor &&
    typeof processor.clearVolatileState === "function"
  );
}
