// Processor authoring API.
// Contracts are pure data/reducer definitions; implementations bind a contract
// to synchronous afterAppend side effects and optional built-in beforeAppend gates.

import type { z } from "zod";
import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import type { ConsumedEvent, EventCatalog, ProcessorState } from "./shared/stream-processors.ts";
import type { ProcessorStream } from "./processor-runner.ts";

/** F-bounded so reduce narrows on the same contract; matches runProcessorReduce. */
export type RunnableContract<Self> = {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  reduce?: (args: {
    contract: Self;
    state: ProcessorState<Self>;
    event: ConsumedEvent<Self>;
  }) => ProcessorState<Self> | null | undefined;
};

export type ProcessorCapabilities = {
  /** The exact stream RPC API this processor is running against. */
  stream: ProcessorStream;
  /**
   * Processor policy helper for replay/catch-up. It returns true when `event` is
   * after the subscription anchor, or within the optional grace period before it.
   * The anchor event itself is not eligible. If the runner has no anchor, it
   * returns true.
   *
   * Ignore this helper when a processor intentionally wants historical side
   * effects for every replayed event.
   */
  shouldApplySideEffects(args: {
    event: Pick<StreamEvent, "offset" | "createdAt">;
    gracePeriodMs?: number;
  }): boolean;
  /**
   * Durable opt-in: "do not checkpoint past this event until `work` completes."
   * Must be called synchronously during afterAppend/afterAppendBatch. Crash
   * before completion => the whole delivery batch is re-delivered from the last
   * saved checkpoint and side effects are at-least-once.
   */
  blockProcessorUntil(work: () => Promise<unknown>): void;
  /**
   * Track detached work without making it part of the checkpoint. In the Durable
   * Object runner this should eventually be backed by alarms; for now it keeps a
   * local reference and reports failures.
   */
  keepAlive(work: unknown): void;
};

export type ProcessorSideEffectAnchor = Pick<StreamEvent, "offset" | "createdAt">;

/** Per-event hook. Everything is an argument -> trivially testable. */
export type AfterAppendArgs<Contract> = ProcessorCapabilities & {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
  streamMaxOffset: number;
};

export type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

/** Per-batch hook. Prefer this when side effects naturally commit in one transaction. */
export type AfterAppendBatchArgs<Contract> = ProcessorCapabilities & {
  events: ReducedEvent<Contract>[];
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
  /** Offset that will be saved after this hook and its blockers succeed. */
  checkpointOffset: number;
  streamMaxOffset: number;
};

export type ProcessorImplementation<Contract> = {
  afterAppend?(args: AfterAppendArgs<Contract>): void;
  afterAppendBatch?(args: AfterAppendBatchArgs<Contract>): void;
};

/** Pre-commit gate args. The event has no offset/createdAt yet. */
export type BeforeAppendArgs<Contract> = {
  event: StreamEventInput;
  state: ProcessorState<Contract>;
};

/** Builtin (inline, in-Stream) implementation: adds the pre-commit gate. */
export type BuiltinImplementation<Contract> = ProcessorImplementation<Contract> & {
  beforeAppend?(args: BeforeAppendArgs<Contract>): void;
};

export type Processor<Contract, Deps> = {
  contract: Contract;
  build(deps: Deps): ProcessorImplementation<Contract>;
};

export type BuiltinProcessor<Contract, Deps> = {
  contract: Contract;
  build(deps: Deps): BuiltinImplementation<Contract>;
};

/**
 * Bind an implementation to a contract. Object-literal `afterAppend` passed
 * through here gets contextual typing, so the override needs NO arg annotation.
 * `build(deps)` is the only place runtime clients are constructed.
 */
export function implementProcessor<Contract extends RunnableContract<Contract>, Deps = void>(
  contract: Contract,
  build: (deps: Deps) => ProcessorImplementation<Contract>,
): Processor<Contract, Deps> {
  return { contract, build };
}

export function implementBuiltinProcessor<Contract extends RunnableContract<Contract>, Deps = void>(
  contract: Contract,
  build: (deps: Deps) => BuiltinImplementation<Contract>,
): BuiltinProcessor<Contract, Deps> {
  return { contract, build };
}
