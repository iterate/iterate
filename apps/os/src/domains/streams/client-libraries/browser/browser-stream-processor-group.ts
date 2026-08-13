// The browser opens one event callback for a stream. Each received event batch
// is passed, in array order, to every configured browser processor. Each
// processor has its own StreamProcessorRunner and progress row; that runner
// commits the processor's SQLite writes and progress row in one transaction.
//
// The callback asks the server to start after the smallest processor
// checkpoint. A processor whose checkpoint is greater ignores event offsets it
// already committed. Processors are called sequentially because they share one
// OPFS SQLite connection. If a processor rejects, earlier commits remain and
// the browser later opens another callback after the new smallest checkpoint.

import { z } from "zod";
import type { AgentUiState } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamEvent } from "iterate/processors";
import type { AnyHostedProcessor } from "iterate/processors";
import type { StreamProcessorEventBatch, StreamProcessorRunner } from "iterate/processors";
import type { ProcessorSnapshot } from "iterate/processors";

/** One browser processor and the runner that stores its state and progress. */
type BrowserProcessorWithRunner = {
  slug: string;
  processor: AnyHostedProcessor;
  // Each processor has a different contract, so the group stores the runners
  // without their individual contract type parameters.
  runner: StreamProcessorRunner<any>;
};

type VolatileAgentProjection = AnyHostedProcessor & {
  prepareVolatileBatch(args: {
    events: readonly StreamEvent[];
    persistedState: unknown;
    persistedThroughOffset: number;
    scannedThroughOffset: number;
  }): unknown | null;
  commitVolatileBatch(candidate: unknown | null): void;
  readonly volatileAgentUiState: AgentUiState | null;
  clearVolatileState(): void;
};

function isVolatileAgentProjection(
  processor: AnyHostedProcessor,
): processor is VolatileAgentProjection {
  return (
    "prepareVolatileBatch" in processor &&
    typeof processor.prepareVolatileBatch === "function" &&
    "commitVolatileBatch" in processor &&
    typeof processor.commitVolatileBatch === "function" &&
    "volatileAgentUiState" in processor &&
    "clearVolatileState" in processor &&
    typeof processor.clearVolatileState === "function"
  );
}

/**
 * Calls an ordered group of browser processors for each received event batch.
 * The first processor reports event-consumption metrics and runtime state. It
 * must therefore be the raw-event cache, which receives every appended event
 * and can measure append-to-cache time.
 *
 * This implements {@link AnyHostedProcessor} because the browser opens one
 * server callback. The server sees the combined contract, while this object
 * calls each local processor separately.
 */
export class BrowserStreamProcessorGroup implements AnyHostedProcessor {
  readonly contract: AnyHostedProcessor["contract"];
  readonly #processors: readonly BrowserProcessorWithRunner[];
  readonly #metricsProcessor: BrowserProcessorWithRunner;

  constructor(processors: readonly BrowserProcessorWithRunner[]) {
    if (!processors.length) {
      throw new Error("BrowserStreamProcessorGroup requires at least one processor");
    }
    this.#processors = processors;
    this.#metricsProcessor = processors[0]!;

    // The server callback uses one contract, so include every event type read
    // or appended by any processor in the group.
    const consumes = new Set<string>();
    const emits = new Set<string>();
    let events: AnyHostedProcessor["contract"]["events"] = {};
    for (const { processor } of processors) {
      for (const type of processor.contract.consumes) consumes.add(type);
      for (const type of processor.contract.emits) emits.add(type);
      events = { ...events, ...processor.contract.events };
    }
    this.contract = {
      slug: "browser-stream-processors",
      version: "0.1.0",
      description: "Calls each configured browser processor for every received event batch.",
      // The group has no reduced state of its own. Each processor runner stores
      // its processor's state separately.
      stateSchema: z.object({}),
      consumes: [...consumes],
      emits: [...emits],
      events,
    };
  }

  /**
   * Metrics come from the first (raw-events) processor rather than being
   * aggregated: the runtime feeds `noteAppendCommitted` here and the loop
   * closes when the appended offset is ingested — and every appended event
   * lands in the raw-events cache, so its committed-batch
   * `noteBatchIngested` closes it. This measures
   * append→cached latency; the feed fold that runs immediately after is a
   * sub-millisecond local step.
   */
  get eventConsumptionMetrics(): AnyHostedProcessor["eventConsumptionMetrics"] {
    return this.#metricsProcessor.processor.eventConsumptionMetrics;
  }

  /** Runtime state reported by the raw-event processor. */
  getRuntimeState(): ReturnType<AnyHostedProcessor["getRuntimeState"]> {
    return this.#metricsProcessor.processor.getRuntimeState();
  }

  /**
   * Open every processor runner. The returned checkpoint is the smallest
   * processor checkpoint, and the returned callback calls the processors
   * sequentially in the configured order.
   */
  async openEventBatchCallback(streamId?: string): Promise<{
    checkpointOffset: number;
    processEventBatch: (batch: StreamProcessorEventBatch) => Promise<void>;
  }> {
    const processorCallbacks: Array<{
      entry: BrowserProcessorWithRunner;
      callback: Awaited<ReturnType<StreamProcessorRunner<any>["openEventBatchCallback"]>>;
      acknowledgedThroughOffset: number;
    }> = [];
    for (const processor of this.#processors) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- Processors share one SQLite connection; opening a runner may transact.
      const callback = await processor.runner.openEventBatchCallback(streamId);
      processorCallbacks.push({
        entry: processor,
        callback,
        acknowledgedThroughOffset: callback.checkpointOffset,
      });
    }
    const checkpointOffset = processorCallbacks.reduce(
      (minimum, processorCallback) =>
        Math.min(minimum, processorCallback.acknowledgedThroughOffset),
      Number.POSITIVE_INFINITY,
    );
    return {
      checkpointOffset: Number.isFinite(checkpointOffset) ? checkpointOffset : 0,
      processEventBatch: async (batch: StreamProcessorEventBatch) => {
        const volatileProcessor = processorCallbacks.find(({ entry }) =>
          isVolatileAgentProjection(entry.processor),
        );
        const volatileCandidate =
          !volatileProcessor || !isVolatileAgentProjection(volatileProcessor.entry.processor)
            ? null
            : volatileProcessor.entry.processor.prepareVolatileBatch({
                events: batch.events,
                persistedState: volatileProcessor.entry.runner.currentState,
                persistedThroughOffset: volatileProcessor.acknowledgedThroughOffset,
                scannedThroughOffset: batch.scannedThroughOffset,
              });
        // Durable projections never receive ephemeral events. Their progress
        // still advances through the complete scan envelope, so omitted live
        // chunks cannot become replayable persistent state on reconnect.
        const durableEvents = batch.events.filter((event) => event.ephemeral !== true);
        // A byte-limited server batch can end before `streamMaxOffset`. If each
        // local runner received that greater offset, each would call
        // Stream.getEvents for events that the same callback will send in its
        // next batch. For a non-empty batch, pass its scanned-through offset as
        // the maximum so processors wait for that next callback batch. Keep the
        // server maximum on an empty batch: no later callback batch exists, so
        // each runner must read any missing durable events itself.
        const processorStreamMaxOffset = !batch.events.length
          ? batch.streamMaxOffset
          : batch.scannedThroughOffset;
        for (const processorCallback of processorCallbacks) {
          // eslint-disable-next-line react-doctor/async-await-in-loop -- Commits must remain ordered on the processors' shared SQLite connection.
          await processorCallback.callback.processEventBatch({
            streamId: batch.streamId,
            events: durableEvents,
            scannedAfterOffset: batch.scannedAfterOffset,
            scannedThroughOffset: batch.scannedThroughOffset,
            streamMaxOffset: processorStreamMaxOffset,
          });
          processorCallback.acknowledgedThroughOffset = Math.max(
            processorCallback.acknowledgedThroughOffset,
            batch.scannedThroughOffset,
          );
        }
        if (volatileProcessor && isVolatileAgentProjection(volatileProcessor.entry.processor)) {
          volatileProcessor.entry.processor.commitVolatileBatch(volatileCandidate);
        }
      },
    };
  }

  /** Current in-memory agent state including ephemeral events. No ephemeral event is represented in a
   * runner snapshot or SQLite row; this is the only live overlay surface. */
  get agentUiState(): AgentUiState | null {
    for (const { processor } of this.#processors) {
      if (isVolatileAgentProjection(processor)) return processor.volatileAgentUiState;
    }
    return null;
  }

  clearVolatileState(): void {
    for (const { processor } of this.#processors) {
      if (isVolatileAgentProjection(processor)) processor.clearVolatileState();
    }
  }

  /**
   * Report the smallest processor offset, which is where the next server
   * callback must begin. `state` is null because each processor stores its own
   * reduced state.
   */
  async snapshot(): Promise<ProcessorSnapshot<unknown>> {
    const snapshots = await Promise.all(
      this.#processors.map((processor) => processor.runner.snapshot()),
    );
    const offset = snapshots.reduce(
      (min, snapshot) => Math.min(min, snapshot.offset),
      Number.POSITIVE_INFINITY,
    );
    return { offset: Number.isFinite(offset) ? offset : 0, state: null };
  }

  /** Stop every runner. Queued callback batches and follow-up event reads then
   * reject instead of overlapping with the next browser database writer. */
  dispose(): void {
    this.clearVolatileState();
    for (const processor of this.#processors) {
      processor.runner.dispose();
    }
  }
}
