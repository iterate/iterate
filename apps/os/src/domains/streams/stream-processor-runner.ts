// The stream-processor RUNNER: the delivery driver that owns everything a
// processor author should not — cursors, checkpoint cadence, retry, recovery —
// so the processor itself can stay three pure-ish hooks (validate / reduce /
// processEvent). Design: docs/stream-processor-runner-redesign.md.
//
// The shape inversion this file exists for: today the HOST is the star
// (`createStreamProcessorHost(ctx)` + `host.add(factory)`, hand-fed a Durable
// Object ctx). Here the PROCESSOR is passed INTO the runner, and the runner is
// a plain runtime-neutral object — the same class runs in a browser tab over
// SQLite, in a Durable Object over KV, and in the in-memory test harness that
// serves as the semantic spec. Nothing Cloudflare-shaped enters the core:
// anything durable arrives through the optional `durability` adapter, and
// anything incarnation-shaped through the optional `keepAlive` hook.
//
// Delivery: `openDelivery()` answers the wake handshake — a resume cursor plus
// a `sink`. The sink IS the `processEventBatch` wire callback the transport
// invokes per delivered frame; transport batching stays entirely inside it.
// The runner reduces/processes ONE EVENT AT A TIME, so batch division is
// invisible to processor semantics (the harness pins this: one batch,
// singletons, or random partitions of the same journal must produce identical
// outcomes). `blockProcessorWhile` is therefore a strict per-event barrier,
// never a per-frame one.
//
// This file is the Phase-1 `SubscriberRunner` home — the post-commit async
// pump. The Phase-2 `InlineRunner` (the Stream DO's own synchronous
// commit-path driver, where `validate` gates appends) shares the types below
// but is gated on a commit-path benchmark. Every method body here is a
// deliberate slice-1 stub: the types and the class surface are the review
// unit; slice 2 fills the bodies in. Nothing calls this yet.

import type { Stream } from "../../itx-api.generated.ts";
import type { ProcessorState } from "./processor-contracts.ts";
import type { StreamEvent } from "./schemas.ts";
import type { MaybePromise, StreamProcessor, StreamProcessorContract } from "./stream-processor.ts";

/**
 * The reduction half of a processor's durable progress: a disposable CACHE of
 * the fold (the journal is the authority). `reducerVersion` is the cache key —
 * a deploy that changes it invalidates the cache and triggers an automatic
 * `reReduce`, which re-runs `reduce` ONLY. That is the whole point of splitting
 * this from {@link ProcessingProgress}: today's single `{offset, state}` cursor
 * makes a routine state-schema deploy refold history AND re-run `processEvent`
 * across it, re-driving real vendor calls.
 */
export type ReductionProgress<State> = {
  /** Cache key for the fold; a mismatch discards `state` and refolds. */
  reducerVersion: string;
  /** The highest offset folded into `state`. */
  reducedThroughOffset: number;
  /** The fold through `reducedThroughOffset`, under `reducerVersion`. */
  state: State;
};

/**
 * The processing half of a processor's durable progress: the AUTHORITATIVE
 * effect-acknowledgement cursor. Unlike the reduction cache it is never
 * discarded — rewinding it re-runs side effects, which only an explicit,
 * audited operator `reprocessFrom` may do. `cursorRevision` is the CAS fence
 * for exactly those rewinds: every commit asserts it, and a bump makes every
 * in-flight continuation of the old cursor position stale (it also feeds
 * {@link DeliveryContext.idempotencyKey}, so an operator redrive genuinely
 * re-emits where a crash retry dedupes).
 */
export type ProcessingProgress = {
  /** Every effect at or below this offset is acknowledged (durably settled). */
  acknowledgedThroughOffset: number;
  /** Monotonic fencing token; bumped by cursor rewinds (`reprocessFrom`/`skipThrough`). */
  cursorRevision: number;
};

/**
 * A processor's two durable positions, persisted as one record. Invariant
 * (when persisted): `reduction.reducedThroughOffset <=
 * processing.acknowledgedThroughOffset` — the fold cache may lag the effect
 * cursor (it is rebuildable), but a fold AHEAD of acknowledged effects would
 * let `snapshot()` show state derived from events whose effects an operator
 * rewind is about to re-run. Core (Phase 2) is the graceful degradation:
 * reduction only, no processing cursor — same structure, same `reReduce`.
 */
export type ProcessorProgress<State> = {
  reduction: ReductionProgress<State>;
  processing: ProcessingProgress;
};

/**
 * Durable progress store, CAS-fenced by `cursorRevision`. The runner reads
 * once at open, then commits per its cadence policy; `commit` rejects
 * (throws) if `expectedCursorRevision` no longer matches the persisted
 * revision — the fence that stops a stale incarnation (or a continuation
 * outliving an operator `reprocessFrom`) from clobbering the rewound cursor.
 * Backends: DO KV, browser SQLite (where the committer folds projection
 * writes and this record into ONE transaction), or a plain object in tests.
 */
export type ProcessorProgressStore<State> = {
  read(): MaybePromise<ProcessorProgress<State> | undefined>;
  commit(
    progress: ProcessorProgress<State>,
    opts: { expectedCursorRevision: number },
  ): MaybePromise<void>;
};

/**
 * Optional recovery capability. Present only for durable processors that own
 * background obligations (`runInBackground` work whose OUTCOME matters): the
 * runner throws at construction if recovery is wired but the contract's
 * `consumes` omits the processor-scoped `<namespace>/revived` event, because a
 * revival fact nobody consumes recovers nothing.
 *
 * - `keepAliveWhile` parks a durable alarm ahead of in-flight work, so an
 *   incarnation that dies owing work is revived by the alarm's fire.
 * - `appendRevived` appends the `<namespace>/revived` fact — the journaled
 *   evidence that guarantees at least one delivery turn (and therefore one
 *   pass of the processor's own reconciliation handlers) even at zero lag.
 * - `handleAlarm` services the durable timer; the host DO multiplexes its
 *   single alarm across runners and routes fires here.
 */
export type ProcessorRecovery = {
  keepAliveWhile(work: () => Promise<unknown>): void;
  appendRevived(): MaybePromise<void>;
  handleAlarm(info?: unknown): MaybePromise<void>;
};

/**
 * The ONE optional durability adapter a hosting runtime hands the runner:
 * `progress` is required whenever the processor is durable at all (without the
 * adapter the runner keeps progress in memory — tests, ephemeral browser
 * views); `recovery` is orthogonal and present only when the processor owns
 * background work that must survive eviction. This is deliberately where
 * every runtime-specific concern lives — no Cloudflare `ctx` in the runner.
 */
export type ProcessorDurability<State> = {
  progress: ProcessorProgressStore<State>;
  recovery?: ProcessorRecovery;
};

/**
 * Where a delivery sits relative to the head the runner has OBSERVED:
 * `"catching-up"` while replaying history, `"live"` once deliveries reach the
 * observed head. A policy input, not a correctness gate — the honest framing
 * that replaces today's `checkpointOffset >= streamMaxOffset` at-head guard.
 */
export type DeliveryPhase = "catching-up" | "live";

/**
 * Honest event-time context handed to `processEvent`. Head and lag are POLICY
 * inputs (skip the stale typing indicator, debounce the status repaint), never
 * correctness — the observed head can be behind the real head the moment it
 * is read. `idempotencyKey` mixes the author's key with the event's
 * `sourceOffset` and the current `cursorRevision`, so a crash retry of the
 * same event dedupes (same offset, same revision) while an operator
 * `reprocessFrom` re-emits (same offset, NEW revision) — no random id, no
 * implicit processor prefix.
 */
export type DeliveryContext = {
  phase: DeliveryPhase;
  /** The highest stream offset the runner has observed (>= this event's). */
  observedHeadOffset: number;
  /** How far this event trails `observedHeadOffset`; 0 = at the observed head. */
  eventsBehindObservedHead: number;
  /** The processing cursor's current fencing token (see {@link ProcessingProgress}). */
  cursorRevision: number;
  /** Derive a deterministic effect key: `authorKey + sourceOffset + cursorRevision`. */
  idempotencyKey(key: string): string;
};

/**
 * The delivery driver for one processor on one stream. Runtime-neutral by
 * construction: the browser, the Durable Object registry, and the in-memory
 * test harness all instantiate exactly this class and differ only in the
 * `durability` / `keepAlive` adapters they pass. One runner per processor —
 * the "host" of old survives only as a thin registry that builds adapters and
 * routes wakes/alarms to the right runner.
 *
 * Slice-1 skeleton: every method throws until slice 2 lands the per-event
 * loop, the two-cursor progress commit, and the cadence policy.
 */
export class StreamProcessorRunner<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> {
  private readonly processor: StreamProcessor<Contract, Deps>;
  private readonly stream: Stream;
  private readonly durability: ProcessorDurability<ProcessorState<Contract>> | undefined;
  private readonly keepAlive: ((work: () => Promise<unknown>) => void) | undefined;
  private readonly now: () => number;

  constructor(args: {
    /** The processor under drive — passed IN; the runner never constructs one. */
    processor: StreamProcessor<Contract, Deps>;
    /** The processor's home stream (replay reads, revival appends). */
    stream: Stream;
    /** Durable progress + optional recovery; omit for in-memory (tests, ephemeral views). */
    durability?: ProcessorDurability<ProcessorState<Contract>>;
    /** Incarnation keep-alive for in-flight async work (a DO's `waitUntil` lane). */
    keepAlive?: (work: () => Promise<unknown>) => void;
    /** Injected clock for the test harness; production uses Date.now. */
    now?: () => number;
  }) {
    this.processor = args.processor;
    this.stream = args.stream;
    this.durability = args.durability;
    this.keepAlive = args.keepAlive;
    this.now = args.now ?? (() => Date.now());
  }

  /**
   * The subscriber half of the wake handshake: answers the resume cursor (the
   * acknowledged-through offset) plus the live `sink` the stream retains and
   * invokes per delivered frame. The sink is the internal `processEventBatch`
   * wire callback — the ONLY place transport batching exists; inside it the
   * runner reduces and processes one event at a time.
   */
  openDelivery(): Promise<{
    checkpointOffset: number;
    sink: (batch: { events: readonly StreamEvent[]; streamMaxOffset: number }) => Promise<void>;
  }> {
    throw new Error("StreamProcessorRunner.openDelivery: implemented in slice 2");
  }

  /** Service a durable alarm fire routed here by the hosting registry (recovery lane). */
  handleAlarm(_info?: unknown): Promise<void> {
    throw new Error("StreamProcessorRunner.handleAlarm: implemented in slice 2");
  }

  /** One consistent read of the fold, pinned to `reducedThroughOffset`. */
  snapshot(): Promise<{ offset: number; state: ProcessorState<Contract> }> {
    throw new Error("StreamProcessorRunner.snapshot: implemented in slice 2");
  }

  /**
   * Rebuild the reduction cache through the acknowledged cursor by re-running
   * `reduce` ONLY — no effects, no cursor movement. Fires automatically on a
   * `reducerVersion` mismatch; callable by operators to heal a corrupt cache.
   */
  reReduce(): Promise<void> {
    throw new Error("StreamProcessorRunner.reReduce: implemented in slice 2");
  }

  /**
   * Operator rewind of the EFFECT cursor (appends an audit event): CAS on
   * `expectedCursorRevision`, set acknowledged = `offset - 1`, bump
   * `cursorRevision` (staling in-flight continuations and rotating
   * `idempotencyKey` derivations so effects genuinely re-emit), reconstruct
   * state, then re-run `reduce` + `processEvent` from `offset`. `snapshot()`
   * honestly rewinds while it catches back up.
   */
  reprocessFrom(_args: {
    offset: number;
    expectedCursorRevision: number;
    reason: string;
  }): Promise<{ cursorRevision: number }> {
    throw new Error("StreamProcessorRunner.reprocessFrom: implemented in slice 2");
  }

  /**
   * The audited escape hatch past a poison event: advance the acknowledged
   * cursor through `offset` WITHOUT running its effects, appending the reason
   * as an audit event. The only exit from the block-retry-forever failure
   * policy — there is deliberately no auto-DLQ.
   */
  skipThrough(_args: { offset: number; reason: string }): Promise<{ cursorRevision: number }> {
    throw new Error("StreamProcessorRunner.skipThrough: implemented in slice 2");
  }

  /** Release delivery resources. Idempotent; a disposed runner rejects new work. */
  dispose(): void {}
}
