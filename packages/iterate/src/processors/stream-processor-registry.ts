// The DO-side "thin registry" over per-processor StreamProcessorRunners —
// every processor-hosting Durable Object runs one. WIRED INTO: the secret DO
// (secret-durable-object.ts — the reference wiring), the project DO
// (multi-processor), the scheduler DO (domain alarm slice), the
// capability-host DO (the recovery template), the repo DO (at-head reconcile
// inside processEvent), and the
// agent DO (agent-durable-object.ts — multi-processor with per-processor
// recovery on its registered processors; the spine's redelivery alone cannot
// cover a SIMULTANEOUS
// Agent+Stream DO death mid-blocker — codex review P1).
//
// THE WIRING RECIPE (established by the secret DO; the same on every DO):
//   1. `createStreamProcessorRegistry(this.ctx, { stream, path, projectId,
//      version: workerVersion(this.env), getLiveState? })`.
//   2. The DO CONSTRUCTS its processor (`new XProcessor({ stream, path,
//      projectId, ...deps })` — the runner owns progress and keepalive; the
//      processor holds no injected durability plumbing) and passes it
//      to `register`, deciding recovery per the module-doc rule below.
//   3. READ-YOUR-WRITES REPOINTING: build `#reads = registry.reads(processor)`
//      and serve every read from it — `new StreamProcessorRpcTarget(this.#reads,
//      { catchUpBeforeSnapshot: () => registry.catchUp(slug), ... })`, DO verbs
//      that read their own fold via `#reads.snapshot()`, and `getLiveState`
//      closures via `#reads.currentState`. The runner owns the cursors; the
//      processor instance holds no fold to read (see `reads` below).
//   4. `alarm()` → `registry.handleAlarm(alarmInfo)`, `wakeStreamSubscriber`
//      → `registry.wakeStreamSubscriber`, `.liveState` →
//      `new LiveStateRpcTarget(registry)`.
//
// The redesign (docs/stream-processor-runner-redesign.md, "option B") allows
// the registry exactly these jobs:
//
//   1. the single-DO-alarm MULTIPLEX — a Durable Object has ONE alarm and
//      `setAlarm` clobbers it, so every subsystem's desire (each runner's
//      keepalive, the scheduler) goes through a named slice and the earliest
//      wins;
//   2. slug→runner ROUTING — wake handshakes to the poked runner, alarm fires
//      to every runner (each keepalive self-gates on its persisted armed
//      time);
//   3. building each runner's `durability` adapters from `ctx`
//      (durable-object-processor-durability.ts);
//
// plus the two responsibilities that live ABOVE any single runner and so
// cannot move into one: the node's LIVE-STATE assembly and the catch-up door.
// Everything per-processor — sink serialization, offset
// dedupe, keepalive tracking of the whole frame attempt, the trailing
// type-unfiltered catch-up behind a consumes-filtered wake batch, cold-load /
// schema-refold handling, read-your-writes waiters — lives in the RUNNER
// (stream-processor-runner.ts); the registry must not re-implement any of it.
// If this file grows behavior beyond the jobs above, it has failed.
//
// RECOVERY IS OPT-IN PER PROCESSOR, AND THE OPT-IN IS LOAD-BEARING (codex
// review §4/#6): the runner cannot detect whether a processor's
// `runInBackground` work is consequential, so the DO author MUST pass
// `{ recovery: true }` to `register` for every processor whose background
// work has an outcome that matters (LLM turns, repo seeds, vendor calls with
// journaled obligations). A processor registered without recovery gets NO
// post-eviction revival: an incarnation that dies owing its work loses that
// work silently — acceptable only for telemetry-grade effects. The runner
// enforces the mechanical half (the contract must consume the core
// `stream/processor-revived` fact); this judgement call is the half only the
// author can make.
//
// KNOWN LIMITATION — retry vs transport parking (codex review §4/#7): a
// permanently failing frame is rethrown by the runner's sink, and the
// existing subscription spine still backs off and eventually PARKS the
// subscription as a durable fact (stream-subscribers.ts). The registry does
// NOT deliver the redesign's "retry blockers indefinitely" policy — transport
// park semantics are deliberately unchanged in this slice, and the spine's
// park-resume controls remain the operator escape. Do not read this file as
// retry-forever.

import * as cloudflareWorkers from "cloudflare:workers";
import { LiveState } from "../itx/live-state/engine.ts";
import type { ProcessorStream } from "./stream-handle.ts";
import type { StreamEvent } from "./schemas.ts";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "./rpc-types.ts";
import type { ProcessorState } from "./processor-contracts.ts";
import type { ProcessorReads, StreamProcessor } from "./stream-processor.ts";
import { StreamProcessorRunner } from "./stream-processor-runner.ts";
import {
  durableObjectProgressStore,
  durableObjectRecovery,
} from "./durable-object-processor-durability.ts";
import {
  announceContract,
  hostRuntimeCapabilities,
  type AnyHostedProcessor,
} from "./processor-host-capabilities.ts";

// Namespace import + fallback rather than a named import: named imports of a
// missing export are ESM LINK errors, and workerd only exposes `tracing`
// where the tracing API is enabled. OS workers get real spans; a runtime
// without them (dynamic user workers, node harnesses) gets the no-op.
const tracing: {
  enterSpan<T>(
    name: string,
    fn: (span: { setAttribute(key: string, value: unknown): void }) => T,
  ): T;
} = cloudflareWorkers.tracing ?? { enterSpan: (_name, fn) => fn({ setAttribute() {} }) };

/**
 * What `register` accepts: a real {@link StreamProcessor} subclass instance
 * that also carries the hosted-capability surface — contract description,
 * runtime state, subscriber metrics — the wake handshake shares with the
 * browser host. The bound is STRUCTURAL ({@link AnyHostedProcessor})
 * because the class itself cannot appear here: it is
 * invariant in its contract parameter (private state storage holds `State` in
 * both positions), so no single instantiation is a supertype of all
 * processors. The "must be a real StreamProcessor" half is enforced at
 * construction instead — the runner's `StreamProcessor.runnerDriver` reaches
 * the class's own private hooks and throws on a structural impostor.
 */
export type RegisterableProcessor = AnyHostedProcessor;

/**
 * The folded-state type of a registered processor, derived from its
 * contract's `stateSchema` — the class's contract parameter is invariant and
 * cannot be named through {@link RegisterableProcessor}'s structural bound,
 * but every concrete subclass's `contract` property already carries the
 * schema whose output IS the state type.
 */
export type RegisteredProcessorState<P extends RegisterableProcessor> = ProcessorState<
  P["contract"]
>;

/**
 * What {@link StreamProcessorRegistry.reads} returns: the RPC-facing
 * {@link ProcessorReads} plus the two synchronous reads a DO's `getLiveState`
 * closure needs (live-state assembly runs synchronously; see `refreshLive`),
 * with `waitUntilEvent` widened to the runner's full waiter — the offset
 * barrier {@link ProcessorReads} publishes over RPC PLUS the in-process-only
 * predicate form (a function cannot cross the RPC facade; a DO wires it into
 * processor deps that wait for a specific future event, e.g. the capability
 * host's script-completion wait).
 */
export type RegisteredProcessorReads<State> = Omit<ProcessorReads<State>, "waitUntilEvent"> & {
  waitUntilEvent(
    input:
      | { offset: number; timeoutMs?: number; signal?: AbortSignal }
      | {
          predicate: (event: StreamEvent) => boolean;
          timeoutMs?: number;
          signal?: AbortSignal;
        },
  ): Promise<void>;
  /** The runner's committed fold, synchronously (schema default until loaded). */
  readonly currentState: State;
  /** Whether `currentState` is a real fold — gate live publishing on it. */
  readonly isLoaded: boolean;
  /**
   * Fold through the durable stream tail or throw. The registry and this
   * processor-specific door have the same strict contract.
   */
  catchUp(): Promise<void>;
};

type RegistryEntry = {
  processor: RegisterableProcessor;
  runner: StreamProcessorRunner<any>;
};

export type StreamProcessorRegistry<Live extends object = Record<string, unknown>> = {
  readonly stream: ProcessorStream;
  /** The node's live-state engine; a `.liveState` RpcTarget exposes getState()/subscribe() over it. */
  readonly live: LiveState<Live>;
  /**
   * Reassemble the live state from current inputs — the ONE writer for the
   * engine. Call it after mutating any non-runner live-state input (the
   * streams index, the demo counter); a runner's own committed-state change
   * calls it automatically via `observeStateChanges`. On a cold DO (a
   * runner's progress not yet loaded) it does nothing instead of publishing
   * the schema default over real facts; `loadAndRefreshLive` is the explicit
   * asynchronous loading door.
   */
  refreshLive(): void;
  /**
   * `refreshLive`'s cold-start sibling: LOAD every runner's progress, THEN
   * reassemble — so the first read/subscription reflects committed writes
   * even on a cold DO. (Distinct names because the difference — one awaits
   * storage, one must not — is exactly what a call site gets wrong.)
   */
  loadAndRefreshLive(): Promise<void>;
  /**
   * Register a processor (constructed by the DO — the processor is the star,
   * the registry is plumbing) under its contract slug and build its runner:
   * durable two-cursor progress in DO KV keyed by the slug, plus — WHEN THE
   * DO PASSES `{ recovery: true }` — the per-runner recovery adapter
   * (keepalive + the core `stream/processor-revived` fact). See the module
   * doc: recovery is REQUIRED for any processor whose `runInBackground` work
   * is consequential; the registry cannot infer that.
   * Duplicate slugs throw. Returns the processor, so DOs keep their
   * `field = registry.register(new XProcessor(...))` shape.
   */
  register<P extends RegisterableProcessor>(processor: P, opts?: { recovery?: boolean }): P;
  /**
   * The runner-backed READ surface for one registered processor. The runner
   * owns both cursors and the fold — the processor instance holds no
   * readable state at all — so every read goes through here. Hand THIS to
   * `new StreamProcessorRpcTarget(...)` and to every DO verb that reads its
   * own fold: `snapshot`/`waitUntilEvent` come from the runner's committed
   * progress; `getRuntimeState` assembles the processor's contributed
   * runtime bag under the runner's snapshot; `currentState` / `isLoaded`
   * serve `getLiveState` closures without an async hop. Takes the registered
   * instance (not a slug) so the state type flows through.
   */
  reads<P extends RegisterableProcessor>(
    processor: P,
  ): RegisteredProcessorReads<RegisteredProcessorState<P>>;
  /** Observe committed fold changes for one registered processor. */
  observeStateChanges<P extends RegisterableProcessor>(
    processor: P,
    observer: (snapshot: { offset: number; state: RegisteredProcessorState<P> }) => void,
  ): () => void;
  /**
   * Wire this to the host DO's wakeStreamSubscriber RPC method. Resolves the
   * poked runner (by the request's `processorSlug`, or the only registered
   * one) and answers with its acknowledged cursor and a fresh sink.
   */
  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse>;
  /**
   * Pull any events the push delivery has not (yet) brought this runner and
   * drive them now. Call before serving a read that must reflect a write the
   * caller just made (read-your-writes): push delivery is asynchronous. The
   * pull is serialized with live frames on the runner's chain, so racing a
   * sink is safe. A direct Durable Object lifecycle loss gets one replay on
   * the runner's durable cursor; all application failures and a second
   * availability failure throw. Stale state is never presented as success.
   */
  catchUp(name: string): Promise<void>;
  /**
   * Wire this to the host DO's `alarm()` handler — REQUIRED on every hosting
   * class. The fire routes to EVERY runner (each keepalive self-gates on its
   * own persisted armed time), so a DO sharing the alarm with its own
   * scheduling (see {@link setAlarmSlice}) calls this unconditionally and
   * then runs its own due work.
   */
  handleAlarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
  /**
   * Share the single DO alarm: each named slice states its own desired fire
   * time (or null for none) and the registry arms the earliest across all
   * slices (each runner's keepalive rides its own `keepalive:<slug>` slice).
   * A slice owner must tolerate early fires (another slice's) and re-arm
   * itself during its handler — in-memory desires do not survive eviction;
   * the durable alarm plus each subsystem's re-derivation do. The returned
   * promise settles when the platform alarm durably reflects the change;
   * await it (and rethrow) where durability is load-bearing (error-path
   * fallbacks), ignore it everywhere else.
   */
  setAlarmSlice(name: string, atMs: number | null): Promise<void>;
  /** The slice's own current desire (NOT the merged alarm time). */
  getAlarmSlice(name: string): number | null;
};

export function createStreamProcessorRegistry<Live extends object = Record<string, unknown>>(
  ctx: DurableObjectState,
  options: {
    stream: ProcessorStream;
    /** Path of the hosted stream. The registry fences every
     * `wakeStreamSubscriber` against this exact `(projectId, path)`: a wake
     * carrying a matching processor slug but a DIFFERENT coordinate is
     * rejected, so a stale or miswired subscription can never fold a foreign
     * stream into this processor. (Provenance stamping still lives in the
     * processors; this is the delivery-side isolation check.) */
    path: string;
    /** Owning project, or null on a global (deployment-root) stream. The other
     * half of the wake coordinate fence (see `path`). */
    projectId: string | null;
    /** Worker deploy version; a change resets each keepalive's crash-loop
     * budget (the antidote deploy). Pass `workerVersion(env)`. REQUIRED: a
     * registry that silently defaulted this could never take the
     * version-reset lane, so a deterministic crash loop would wait out the
     * full plateau even after the fixing deploy shipped. */
    version: string;
    /** Injected clock for the node test harness; production uses Date.now. */
    now?: () => number;
    /**
     * Assemble this node's live state (see `LiveState`) — this is what TYPES
     * the registry's `Live` parameter. Called on every registered runner's
     * committed-state change and on `loadAndRefreshLive`. Omit and the live
     * state is the primary (first-registered) runner's reduced state
     * (untyped: `Live` stays the default record); provide it to project a
     * redacted view or fold in extras (e.g. a streams index).
     */
    getLiveState?: () => Live;
  },
): StreamProcessorRegistry<Live> {
  const entries = new Map<string, RegistryEntry>();
  const now = options.now ?? (() => Date.now());

  // ---------------------------------------------------------------------------
  // The shared DO alarm. A Durable Object has exactly ONE alarm and setAlarm
  // clobbers it, so every desire goes through this slice map and the earliest
  // wins.
  // Slices are in-memory (an eviction loses them) and that is correct: the
  // durable alarm itself survives, its fire runs every subsystem's handler,
  // and each handler re-derives its own desire — a keepalive from its KV
  // record, the scheduler from its fold.
  // ---------------------------------------------------------------------------
  const alarmSlices = new Map<string, number>();
  /**
   * A durable alarm armed by a PREVIOUS incarnation whose owning slice we
   * cannot know (in-memory desires died with it). The first reconcile adopts
   * it as a desire of its own so this incarnation's arming/disarming cannot
   * clobber it; the next actual fire drops it — every subsystem re-derives
   * its desire in that turn.
   */
  const INHERITED_ALARM_SLICE = "@inherited";
  /** What the platform alarm holds; null = cleared, undefined = unknown. */
  let platformAlarmAtMs: number | null | undefined;
  /** Serializes alarm storage ops so read-adopt and writes cannot interleave. */
  let alarmChain: Promise<void> = Promise.resolve();
  /**
   * Returns the settled write for callers whose correctness depends on the
   * alarm being DURABLY armed (the alarm handler, the scheduler's error-path
   * fallback) — a rejected step means the platform alarm may not exist, and
   * such callers must rethrow so the platform retries them. Fire-and-forget
   * callers may ignore the result: the chain observes the rejection either
   * way, and the next reconcile re-reads and re-issues.
   */
  function reconcileAlarm(): Promise<void> {
    const step = alarmChain.then(async () => {
      if (platformAlarmAtMs === undefined) {
        const existing = await ctx.storage.getAlarm();
        platformAlarmAtMs = existing;
        if (existing !== null) alarmSlices.set(INHERITED_ALARM_SLICE, existing);
      }
      let earliest: number | null = null;
      for (const atMs of alarmSlices.values()) {
        if (earliest === null || atMs < earliest) earliest = atMs;
      }
      if (earliest === platformAlarmAtMs) return;
      platformAlarmAtMs = earliest;
      if (earliest === null) await ctx.storage.deleteAlarm();
      else await ctx.storage.setAlarm(earliest);
    });
    alarmChain = step.catch((error: unknown) => {
      platformAlarmAtMs = undefined; // unknown — the next reconcile re-reads
      console.error("stream processor registry alarm arming failed", error);
    });
    ctx.waitUntil(alarmChain);
    return step;
  }
  function setAlarmSlice(name: string, atMs: number | null): Promise<void> {
    if (atMs === null) alarmSlices.delete(name);
    else alarmSlices.set(name, atMs);
    return reconcileAlarm();
  }

  function requireEntry(name: string): RegistryEntry {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(
        `Unknown stream processor "${name}" on this registry (registered: ${[...entries.keys()].join(", ") || "none"})`,
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
      `wakeStreamSubscriber for "${args.subscriptionKey}" needs a processorSlug on a multi-processor registry (registered: ${[...entries.keys()].join(", ")})`,
    );
  }

  // The node's live-state engine. Seeded empty; assembled from runner state
  // on the first `loadAndRefreshLive`
  // and kept fresh by each runner's committed-state observer. The empty seed
  // and the primary-runner fallback are the two places the registry must
  // assert `Live` (they only apply when `getLiveState` was omitted, where
  // `Live` is the default record type anyway).
  const live = new LiveState<Live>({} as Live);
  function assembleLive(): void {
    // An unloaded runner reports the schema DEFAULT as currentState —
    // assembling from that would push patches that wipe real facts to live
    // subscribers (e.g. a cold DO whose first wake is a touchStreamActivity).
    // Only loadAndRefreshLive may cross storage; once it completes this
    // reassembly runs with every real fold.
    if ([...entries.values()].some((entry) => !entry.runner.isLoaded)) {
      return;
    }
    const primary = [...entries.values()][0]?.runner.currentState as Live | undefined;
    live.setState(options.getLiveState?.() ?? primary ?? ({} as Live));
  }
  async function loadThenAssemble(): Promise<void> {
    // Loading is all-or-nothing: publishing a projection assembled from only
    // the processors whose storage happened to respond would turn an
    // availability failure into false domain state. snapshot() performs any
    // required refold and throws on failure; the caller sees that failure and
    // may retry the read against a fresh incarnation.
    await Promise.all([...entries.values()].map((entry) => entry.runner.snapshot()));
    assembleLive();
  }

  return {
    stream: options.stream,
    live,
    refreshLive: assembleLive,
    loadAndRefreshLive: loadThenAssemble,

    register(processor, opts) {
      const { slug } = processor.contract;
      if (entries.has(slug)) {
        throw new Error(`Stream processor "${slug}" is already registered on this registry`);
      }
      // Recovery FIRST, because durableObjectRecovery's construction re-issues
      // a persisted alarm desire (the lost-platform-alarm heal) through this
      // runner's own slice — and because the runner's constructor validates
      // that the contract consumes the core `stream/processor-revived` fact.
      const recovery = opts?.recovery
        ? durableObjectRecovery({
            storage: ctx.storage,
            slug,
            stream: options.stream,
            version: options.version,
            armAlarm: (atMs) => void setAlarmSlice(`keepalive:${slug}`, atMs),
            waitUntil: (work) => ctx.waitUntil(work),
            now,
          })
        : undefined;
      const runner = new StreamProcessorRunner({
        // See RegisterableProcessor: the class is invariant in its contract,
        // so the structural door narrows back to the class here; runnerDriver
        // (inside the constructor) fails loudly on anything that is not a
        // real StreamProcessor instance.
        processor: processor as unknown as StreamProcessor<any, any>,
        stream: options.stream,
        durability: {
          progress: durableObjectProgressStore({
            storage: ctx.storage,
            slug,
          }),
          ...(recovery === undefined ? {} : { recovery }),
        },
        // Recovery-less runners still keep the incarnation alive while their
        // registered work runs; they just get no post-eviction alarm (see the
        // module doc for when that is acceptable).
        keepAlive: (work) => ctx.waitUntil(work()),
        now,
      });
      entries.set(slug, { processor, runner });
      // Any runner's committed-state change reassembles the node's live state.
      runner.observeStateChanges(() => assembleLive());
      return processor;
    },

    reads(processor) {
      const entry = requireEntry(processor.contract.slug);
      if (entry.processor !== processor) {
        throw new Error(
          `stream processor "${processor.contract.slug}" is registered on this registry, ` +
            `but reads() was passed a DIFFERENT instance — build reads from the exact ` +
            `processor register() returned`,
        );
      }
      const { runner } = entry;
      const reads: RegisteredProcessorReads<unknown> = {
        snapshot: () => runner.snapshot(),
        getRuntimeState: async () => {
          // The processor contributes only its runtime bag; the SNAPSHOT half
          // comes from the runner's committed progress — the same assembly
          // the wake handshake's capability performs (metrics excluded here:
          // this is the inspection read, not the wake capability).
          const contributed = await entry.processor.getRuntimeState();
          return { ...contributed, snapshot: await runner.snapshot() };
        },
        // The union parameter narrows into the runner's two overloads; both
        // branches are the same passthrough.
        waitUntilEvent: (input) =>
          "offset" in input ? runner.waitUntilEvent(input) : runner.waitUntilEvent(input),
        catchUp: () => runner.catchUp(),
        get currentState() {
          return runner.currentState;
        },
        get isLoaded() {
          return runner.isLoaded;
        },
      };
      // The runner is stored under the type-erased `RegistryEntry` (a map of
      // heterogeneous processors), so the concrete state type re-enters here:
      // the registered instance's contract carries it, and `reads()` promised
      // it in the signature.
      return reads as RegisteredProcessorReads<RegisteredProcessorState<typeof processor>>;
    },

    observeStateChanges(processor, observer) {
      const entry = requireEntry(processor.contract.slug);
      if (entry.processor !== processor) {
        throw new Error(
          `stream processor "${processor.contract.slug}" is registered on this registry, ` +
            "but observeStateChanges() was passed a DIFFERENT instance",
        );
      }
      // The identity check above restores the relationship erased by the
      // registry's heterogeneous entry map: this runner and observer share the
      // state type carried by the exact registered processor instance.
      return entry.runner.observeStateChanges(
        observer as (snapshot: { offset: number; state: unknown }) => void,
      );
    },

    // Catch-up failures — availability and application alike — propagate to
    // the caller unretried: the door that called into this DO owns the one
    // idempotent replay, and a swallowed failure here would serve stale
    // state as success.
    async catchUp(name: string): Promise<void> {
      await requireEntry(name).runner.catchUp();
    },

    handleAlarm(alarmInfo) {
      return tracing.enterSpan("alarm processor keepalive", async (span) => {
        // Entering alarm() means the platform consumed the durable alarm:
        // whatever we believed was armed no longer is, and every reconcile
        // from here must re-issue rather than skip as "unchanged".
        platformAlarmAtMs = null;
        // Every DUE desire is dropped, not just the inherited one: the slice
        // that caused this fire is delivered — its owner re-derives and
        // re-arms during this very turn (a keepalive synchronously in
        // onAlarm; the scheduler at the end of its body). Keeping a due
        // desire would re-arm the just-consumed alarm IN THE PAST and refire
        // it concurrently with the handler body still running.
        const firedAt = now();
        for (const [name, atMs] of alarmSlices) {
          if (atMs <= firedAt) alarmSlices.delete(name);
        }
        span.setAttribute("iterate.alarm.kind", "processor_keepalive");
        if (alarmInfo !== undefined) {
          span.setAttribute("iterate.alarm.is_retry", alarmInfo.isRetry);
          span.setAttribute("iterate.alarm.retry_count", alarmInfo.retryCount);
        }
        try {
          // EVERY runner gets the fire — each keepalive self-gates on its own
          // persisted armed time, so a foreign fire is a no-op. Failures are
          // collected (never short-circuit: the runners behind a throwing one
          // still need their fire) and rethrown after the loop so the
          // platform retries the handler; retried fires are safe for runners
          // that already handled theirs (self-gated again).
          const failures: unknown[] = [];
          for (const [name, entry] of entries) {
            try {
              await entry.runner.handleAlarm(alarmInfo);
            } catch (error) {
              console.error(`stream processor "${name}" alarm handling failed`, error);
              failures.push(error);
            }
          }
          if (failures.length > 0) throw failures[0];
        } finally {
          // Awaited AND rethrown: the platform only retries an alarm whose
          // handler THREW. Resolving with the re-arm still queued (or
          // silently failed) would consume the alarm for good — an eviction
          // in that window loses the only thing that revives this DO.
          await reconcileAlarm();
        }
      });
    },

    setAlarmSlice,
    getAlarmSlice: (name) => alarmSlices.get(name) ?? null,

    async wakeStreamSubscriber(args) {
      // Coordinate fence. A wake is only legitimate from the EXACT stream this
      // registry hosts, `(projectId, path)`. The poke is a trusted-internal
      // RPC, but a stale, malformed, hand-configured, or copied subscription
      // can still target this registry's slug from a DIFFERENT coordinate —
      // and the delivery spine would invoke it. Without this fence the mismatch
      // is accepted: foreign events fold into this processor's state, its
      // consequences run against this processor's fixed Stream capability, and
      // its checkpoint advances on foreign offsets. Reject before resolving the
      // processor or opening delivery. (Selecting by `processorSlug` alone is
      // the gap this closes — the slug is not unique across streams.)
      if (args.stream.projectId !== options.projectId || args.stream.path !== options.path) {
        throw new Error(
          `wakeStreamSubscriber coordinate mismatch: wake for ${args.stream.projectId ?? "null"}:${args.stream.path} does not match registry ${options.projectId ?? "null"}:${options.path}`,
        );
      }
      const name = resolveProcessorName(args);
      const entry = requireEntry(name);
      // The runner's sink IS the handshake sink: it already serializes and
      // offset-dedupes frames, tracks the WHOLE attempt on the keepalive, and
      // runs the trailing type-unfiltered pull behind a consumes-filtered
      // batch left short of the raw head (codex review #1) — the registry
      // must not wrap it in a second copy of any of that.
      const opened = await entry.runner.openDelivery();
      // The capability assembles runtime state from its two honest sources:
      // the SNAPSHOT from the runner (the cursor owner) and the runtime bag +
      // metrics from the processor. Same Cloudflare clock domain, so the
      // ping's one-way estimate is omitted and the clock-offset estimate is
      // ~zero.
      const capabilities = hostRuntimeCapabilities(entry.processor, {
        now,
        snapshot: () => entry.runner.snapshot(),
      });
      return {
        // The PROCESSING cursor — the stream persists this as its delivery
        // watermark, and a reduction-pinned offset could skip events whose
        // effects were never acknowledged (codex review §2).
        checkpointOffset: opened.checkpointOffset,
        sink: opened.sink,
        subscriber: {
          processor: { announcement: announceContract(entry.processor.contract) },
        },
        ...capabilities,
      };
    },
  };
}
