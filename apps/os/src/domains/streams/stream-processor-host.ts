// Hosts class-based StreamProcessors inside a Durable Object.
//
// The aesthetic this enables:
//
// ```ts
// export class AgentDurableObject extends DurableObject<Env> {
//   host = createStreamProcessorHost(this.ctx, { stream, version: workerVersion(this.env) });
//   agent = this.host.add((deps) => new AgentProcessor({ ...deps, ai }));
//   search = this.host.add((deps) => new SearchProcessor(deps));
//
//   wakeStreamSubscriber(args: StreamSubscriberWakeRequest) {
//     return this.host.wakeStreamSubscriber(args);
//   }
//
//   alarm() {
//     return this.host.handleAlarm();
//   }
// }
// ```
//
// EVERY hosting DO class must wire `alarm()` to `handleAlarm()`: the host
// parks a durable alarm ahead of in-flight side-effect work (the keepalive,
// stream-processor-keepalive.ts), and that alarm firing in a fresh
// incarnation is the ONLY thing that revives a DO that died owing work on a
// quiet stream. A DO that needs the alarm for its own scheduling too (the
// scheduler) shares it through `setAlarmSlice` — the host arms the earliest
// desire across every slice, and each subsystem self-gates on whether the
// fire was its own.
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
//
// What the spine's durable retries CANNOT cover is the ZERO-LAG wedge: a
// batch that checkpointed fine but whose `runInBackground` attempt died with
// the incarnation. From the stream's side there is nothing left to deliver,
// so nothing ever dials this DO again. The keepalive closes that: its alarm
// fires post-eviction, the host appends one revival fact to the stream (which
// cold-boots the stream DO and restores the spine) and pulls every processor
// through its pending events — the fact guarantees at least one batch, and
// every processor's end-of-batch reconciliation settles what the dead
// incarnation left behind.

import type { Stream } from "../../itx-api.generated.ts";
import { LiveState } from "../../lib/live-state/engine.ts";
import type {
  GetProcessorRuntimeState,
  StreamEventBatch,
  StreamPingInput,
  StreamSubscriberPing,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "./rpc-types.ts";
import type { SubscriberMetrics } from "./subscriber-metrics.ts";
import type { StreamProcessorRuntimeState, StreamProcessorSnapshot } from "./stream-processor.ts";
import type { ProcessorContractAnnouncement } from "./core-processor-contract.ts";
import { ProcessorKeepalive, type KeepaliveRecord } from "./stream-processor-keepalive.ts";

/**
 * The journaled evidence a revival pass appends before pulling processors
 * through their pending events. Its delivery is what guarantees at least one
 * batch (and therefore one reconciliation pass) even when the checkpoint was
 * already at the head — and it makes the whole episode readable in the raw
 * event feed: requested → revived → failure completion → reschedule.
 */
export const PROCESSOR_HOST_REVIVED_EVENT_TYPE = "events.iterate.com/stream-processor-host/revived";

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
  /** The current reduced state, synchronously — feeds live-state assembly without an async hop. */
  currentState: unknown;
  /** Whether `currentState` is the fold and not the schema default (see StreamProcessor.isLoaded). */
  readonly isLoaded: boolean;
  /**
   * Self-measured consumption metrics — every hosted processor has one
   * (StreamProcessor provides it; Pick keeps this structural). Hosts merge
   * its report into the `getRuntimeState` answer and feed observed pings
   * into it — see {@link hostRuntimeCapabilities}.
   */
  readonly subscriberMetrics: Pick<
    SubscriberMetrics,
    "report" | "notePingObserved" | "noteAppendCommitted" | "clearPendingAppends"
  >;
  /** Host confirmation that the journal is folded through head (the zero-batch catch-up case). */
  markLoaded(): void;
  /** Observe reduced-state changes in-process (a local function, not a retained RPC stub). */
  observeStateChanges(observer: (snapshot: StreamProcessorSnapshot<unknown>) => void): () => void;
};

type HostedEntry = {
  processor: AnyHostedProcessor;
  /** Serializes sink batches per processor; ingest also dedupes by offset internally. */
  ingestChain: Promise<void>;
};

type ApplicationSpan = {
  setAttribute(name: string, value: boolean | number | string): void;
};

export type StreamProcessorHost<Live extends object = Record<string, unknown>> = {
  readonly stream: Stream;
  /** The node's live-state engine; a `.liveState` RpcTarget exposes getState()/subscribe() over it. */
  readonly live: LiveState<Live>;
  /**
   * Reassemble the live state from current inputs — the ONE writer for the
   * engine. Call it after mutating any non-processor live-state input (the
   * streams index, the demo counter); a processor's own state change calls it
   * automatically via `observeStateChanges`. The diff makes a full reassembly
   * cheap (unchanged slices keep identity), so there is no need to poke
   * individual slices. On a cold DO (a processor's checkpoint not yet loaded)
   * it defers to an async load-then-assemble instead of publishing the schema
   * default over real facts.
   */
  refreshLive(): void;
  /**
   * `refreshLive`'s cold-start sibling: LOAD every processor's checkpoint,
   * THEN reassemble — so the first read/subscription reflects committed
   * writes even on a cold DO. (Distinct names because the difference — one
   * awaits storage, one must not — is exactly what a call site gets wrong.)
   */
  loadAndRefreshLive(): Promise<void>;
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
  /**
   * Wire this to the host DO's `alarm()` handler — REQUIRED on every hosting
   * class. The keepalive self-gates on whether the fire was its own, so a DO
   * sharing the alarm with its own scheduling (see {@link setAlarmSlice})
   * calls this unconditionally and then runs its own due work.
   */
  handleAlarm(alarmInfo?: AlarmInvocationInfo, span?: ApplicationSpan): Promise<void>;
  /**
   * Share the single DO alarm: each named slice states its own desired fire
   * time (or null for none) and the host arms the earliest across all slices
   * plus the keepalive's. A slice owner must tolerate early fires (another
   * slice's) and re-arm itself during its handler — in-memory desires do not
   * survive eviction; the durable alarm plus each subsystem's re-derivation
   * do. The returned promise settles when the platform alarm durably reflects
   * the change; await it (and rethrow) where durability is load-bearing
   * (error-path fallbacks), ignore it everywhere else.
   */
  setAlarmSlice(name: string, atMs: number | null): Promise<void>;
  /** The slice's own current desire (NOT the merged alarm time). */
  getAlarmSlice(name: string): number | null;
};

export function createStreamProcessorHost<Live extends object = Record<string, unknown>>(
  ctx: DurableObjectState,
  options: {
    stream: Stream;
    /** Path of the hosted stream — stamped as provenance on processor appends. */
    path: string;
    /** Owning project, or null on a global (deployment-root) stream. */
    projectId: string | null;
    /** Worker deploy version; a change resets the keepalive's crash-loop
     * budget (the antidote deploy). Pass `workerVersion(env)`. REQUIRED: a
     * host that silently defaulted this could never take the version-reset
     * lane, so a deterministic crash loop would wait out the full plateau
     * even after the fixing deploy shipped. */
    version: string;
    /** Injected clock for the node test harness; production uses Date.now. */
    now?: () => number;
    /** Catch-up read page size; tests shrink it to exercise paging. */
    catchUpPageSize?: number;
    /**
     * Assemble this node's live state (see `LiveState`) — this is what TYPES
     * the host's `Live` parameter. Called on every hosted processor's state
     * change and on `loadAndRefreshLive`. Omit and the live state is the
     * primary (first-registered) processor's reduced state (untyped: `Live`
     * stays the default record); provide it to project a redacted view or fold
     * in extras (e.g. a streams index).
     */
    getLiveState?: () => Live;
  },
): StreamProcessorHost<Live> {
  const entries = new Map<string, HostedEntry>();

  const snapshotKey = (name: string) => `stream-processor:${name}:snapshot`;
  const KEEPALIVE_RECORD_KEY = "stream-processor-host:keepalive";

  // ---------------------------------------------------------------------------
  // The shared DO alarm. A Durable Object has exactly ONE alarm and setAlarm
  // clobbers it, so every desire goes through this slice map and the earliest
  // wins. Slices are in-memory (an eviction loses them) and that is correct:
  // the durable alarm itself survives, its fire runs every subsystem's
  // handler, and each handler re-derives its own desire — the keepalive from
  // its KV record, the scheduler from its fold.
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
      console.error("stream processor host alarm arming failed", error);
    });
    ctx.waitUntil(alarmChain);
    return step;
  }
  function setAlarmSlice(name: string, atMs: number | null): Promise<void> {
    if (atMs === null) alarmSlices.delete(name);
    else alarmSlices.set(name, atMs);
    return reconcileAlarm();
  }

  const now = options.now ?? (() => Date.now());
  const keepalive = new ProcessorKeepalive({
    now,
    readRecord: () => ctx.storage.kv.get<KeepaliveRecord>(KEEPALIVE_RECORD_KEY) ?? undefined,
    writeRecord: (record) => void ctx.storage.kv.put(KEEPALIVE_RECORD_KEY, record),
    armAlarm: (atMs) => setAlarmSlice("keepalive", atMs),
    keepAlive: (work) => void ctx.waitUntil(work),
    revive: async (record) => {
      // The append cold-boots the stream DO if the deploy evicted it too (its
      // `woken` fan-out restores the spine's deliveries), guarantees at least
      // one pending event, and journals the episode. The catch-up pulls are
      // UNFILTERED — unlike wake-mode push, which filters by each contract's
      // consumes list — so the fact reaches every processor's batch and the
      // end-of-batch reconciliations run even for processors that do not
      // consume it. Failures throw: the keepalive's breaker owns retries.
      await options.stream.append({
        type: PROCESSOR_HOST_REVIVED_EVENT_TYPE,
        // Keyed per attempt: a platform retry of a throwing alarm handler
        // re-runs the pass without journaling a duplicate fact; distinct
        // attempts (distinct mark timestamps) still narrate individually.
        idempotencyKey: `processor-host-revived@${record.version}:${record.revivals}:${record.lastRevivalAt}`,
        payload: {
          revivals: record.revivals,
          version: record.version,
          processors: [...entries.keys()],
        },
      });
      for (const name of entries.keys()) {
        await catchUpInternal(name, { rethrow: true });
      }
    },
    appendFact: (event) => {
      void Promise.resolve(options.stream.append(event)).catch((error: unknown) => {
        console.error("stream processor host evidence append failed", error);
      });
    },
    version: options.version,
  });
  // A fresh incarnation restores the keepalive's persisted desire — and
  // RE-ISSUES it. The desire surviving only in the slice map would leave a
  // lost platform alarm (a setAlarm that failed or an eviction in the
  // fire→re-arm window) permanently unrecoverable even though the DO is being
  // dialed right now; the reconcile makes every dial self-healing. Healthy
  // path: the read-adopt sees the identical armed alarm and the write is
  // skipped as unchanged.
  if (keepalive.armedAtMs !== null) {
    alarmSlices.set("keepalive", keepalive.armedAtMs);
    void reconcileAlarm();
  }

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

  async function catchUpInternal(name: string, opts: { rethrow: boolean }): Promise<void> {
    const entry = requireEntry(name);
    const pageSize = options.catchUpPageSize ?? 500;
    try {
      const { offset } = await entry.processor.snapshot();
      // Default read = durable rows only. Load-bearing: catch-up must fold
      // exactly what the wake lane delivers (which drops ephemeral events),
      // or a refold would diverge from the live fold. Do not add
      // includeEphemeral here.
      using pager = options.stream.readEvents({ afterOffset: offset, limit: pageSize });
      // One page of lookahead, so every non-final batch carries a
      // streamMaxOffset PAST its own tail. Reconcilers defer side effects
      // until checkpointOffset >= streamMaxOffset — acting on a mid-catch-up
      // fold would re-drive attempts whose completions sit in the next page —
      // and that gate only works if a behind batch can SEE it is behind. The
      // final page reports its own tail (the head as of this read), exactly
      // like a live push batch, so its reconciliation runs.
      let events = await pager.next();
      while (events.length > 0) {
        const lookahead = await pager.next();
        // Non-consumed event types reduce to no-ops but still advance the
        // checkpoint, mirroring what a filtered delivery's cursor does.
        await entry.processor.ingest({
          events,
          streamMaxOffset: (lookahead.at(-1) ?? events.at(-1))!.offset,
        });
        events = lookahead;
      }
      // Folded through head as of this read. Ingest already marks itself
      // loaded per batch; this covers the one case it can't — a clean
      // catch-up that delivered ZERO batches (e.g. a discarded checkpoint
      // over an empty journal), where the current state — even the schema
      // default — is by construction the fold.
      entry.processor.markLoaded();
    } catch (error) {
      if (opts.rethrow) throw error;
      console.error(
        `stream processor "${name}" catch-up failed; serving last ingested state`,
        error,
      );
    }
  }

  // The node's live-state engine. Seeded empty; assembled from processor state
  // on the first `loadAndRefreshLive` and kept fresh by each processor's observer.
  // The empty seed and the primary-processor fallback are the two places the
  // host must assert `Live` (they only apply on hosts that omitted
  // `getLiveState`, where `Live` is the default record type anyway).
  const live = new LiveState<Live>({} as Live);
  function assembleLive(): void {
    // An unloaded processor reports the schema DEFAULT as currentState —
    // assembling from that would push patches that wipe real facts to live
    // subscribers (e.g. a cold DO whose first wake is a touchStreamActivity).
    // Load first, then this reassembly re-runs with the real fold.
    if ([...entries.values()].some((entry) => !entry.processor.isLoaded)) {
      void loadThenAssemble();
      return;
    }
    const primary = [...entries.values()][0]?.processor.currentState;
    live.setState(options.getLiveState?.() ?? ((primary ?? {}) as Live));
  }
  async function loadThenAssemble(): Promise<void> {
    await Promise.all(
      [...entries.values()].map((entry) => entry.processor.snapshot().catch(() => undefined)),
    );
    // Still-unloaded after the snapshot read = a checkpoint DISCARDED at load
    // (schema mismatch after a state-shape deploy): the fold must come from
    // the journal. Catch up exactly those processors — so one stale
    // checkpoint never blocks the peer slices assembled in getLiveState —
    // and a clean catch-up marks even an empty journal loaded.
    await Promise.all(
      [...entries.entries()]
        .filter(([, entry]) => !entry.processor.isLoaded)
        .map(([name]) => catchUpInternal(name, { rethrow: false })),
    );
    // A processor that STILL isn't loaded (storage/read failures all the way
    // down): KEEP the last assembled state rather than publishing defaults as
    // facts — the failed loads cleared their memos, so the next refresh (or
    // the storage-failure DO restart) retries.
    if ([...entries.values()].some((entry) => !entry.processor.isLoaded)) return;
    assembleLive();
  }

  return {
    stream: options.stream,
    live,
    refreshLive: assembleLive,
    loadAndRefreshLive: loadThenAssemble,
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
        // Every registered side-effect closure (blockProcessorWhile and
        // runInBackground alike) rides through the keepalive: while any of it
        // is in flight, a durable alarm sits a few seconds ahead, and an
        // incarnation that dies owing work gets revived by its fire.
        keepAliveWhile: (work) => keepalive.track(work()),
      });
      if (entries.has(processor.contract.slug)) {
        throw new Error(
          `Stream processor "${processor.contract.slug}" is already registered on this host`,
        );
      }
      registeredSlug = processor.contract.slug;
      entries.set(registeredSlug, { processor, ingestChain: Promise.resolve() });
      // Any processor's reduced-state change reassembles the node's live state.
      processor.observeStateChanges(() => assembleLive());
      return processor;
    },

    catchUp: (name) => catchUpInternal(name, { rethrow: false }),

    async handleAlarm(alarmInfo, span) {
      // Entering alarm() means the platform consumed the durable alarm:
      // whatever we believed was armed no longer is, and every reconcile from
      // here must re-issue rather than skip as "unchanged".
      platformAlarmAtMs = null;
      // Every DUE desire is dropped, not just the inherited one: the slice
      // that caused this fire is delivered — its owner re-derives and re-arms
      // during this very turn (the keepalive synchronously in onAlarm; the
      // scheduler at the end of its body). Keeping a due desire would re-arm
      // the just-consumed alarm IN THE PAST and refire it concurrently with
      // the handler body still running.
      const firedAt = now();
      for (const [name, atMs] of alarmSlices) {
        if (atMs <= firedAt) alarmSlices.delete(name);
      }
      if (span !== undefined) {
        span.setAttribute("iterate.alarm.kind", "processor_keepalive");
        span.setAttribute("iterate.stream.path", options.path.slice(0, 256));
        if (options.projectId !== null) {
          span.setAttribute("iterate.project.id", options.projectId);
        }
        if (alarmInfo !== undefined) {
          span.setAttribute("iterate.alarm.is_retry", alarmInfo.isRetry);
          span.setAttribute("iterate.alarm.retry_count", alarmInfo.retryCount);
        }
      }
      try {
        try {
          const action = await keepalive.onAlarm();
          span?.setAttribute("iterate.alarm.action", action);
        } finally {
          // Awaited AND rethrown: the platform only retries an alarm whose
          // handler THREW. Resolving with the re-arm still queued (or silently
          // failed) would consume the alarm for good — an eviction in that
          // window loses the only thing that revives this DO.
          await reconcileAlarm();
        }
      } catch (error) {
        if (span !== undefined) {
          span.setAttribute(
            "error.type",
            (error instanceof Error ? error.name : typeof error).slice(0, 128),
          );
        }
        throw error;
      }
    },

    setAlarmSlice,
    getAlarmSlice: (name) => alarmSlices.get(name) ?? null,

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
        // Tracked, not merely waitUntil'd: the keepalive keeps the DO alive
        // through ingest AND parks its alarm ahead of it, so an eviction
        // mid-batch on a stream that also died (a deploy takes both) still
        // gets this host redialed — the stream-side retry needs the stream
        // DO awake to notice the corpse.
        keepalive.track(attempt);
        // Wake-lane batches are consumes-FILTERED but stamped with the RAW
        // stream head, so a delivered batch can leave the checkpoint behind
        // streamMaxOffset with nothing ever delivering the difference (a
        // non-consumed tail event — a presence fact — produces no further
        // push). The reconcilers' at-head gate rightly defers on such folds,
        // so every behind batch gets a trailing type-unfiltered catch-up: it
        // checkpoints through the non-consumed DURABLE tail and its final
        // page reports its own tail as the head, so its reconciliation runs.
        // One honest hole: an EPHEMERAL tail (a mid-turn chunk run) is
        // invisible to this pull too — the checkpoint parks below the raw
        // head and the deferred reconcile waits for the next durable fact.
        // Every producer pattern ends with one (chunks → output-added;
        // revival appends `revived`), so the deferral is bounded by design:
        // reconciliation is guaranteed relative to the DURABLE head, not the
        // allocator head. Already-at-head batches pay one snapshot read.
        keepalive.track(
          attempt.then(
            async () => {
              const { offset } = await entry.processor.snapshot();
              if (offset < batch.streamMaxOffset) {
                // Rethrown into the tracked promise: a failed trailing pull
                // leaves the checkpoint behind a head nothing will re-push,
                // so it must read as a FAILURE to the keepalive — blocking
                // the quiet-clean disarm and routing the next alarm fire to
                // revival, whose unfiltered catch-up is this pull's retry.
                await catchUpInternal(name, { rethrow: true });
              }
            },
            () => {
              // A failed ingest is the spine's problem (nack → backoff →
              // redelivery); the trailing pull only follows success.
            },
          ),
        );
        return attempt;
      };

      return {
        checkpointOffset: snapshot.offset,
        sink,
        subscriber: {
          processor: { announcement: announceContract(entry.processor.contract) },
        },
        // Same Cloudflare clock domain, so the ping's one-way estimate is
        // omitted and the clock-offset estimate is ~zero.
        ...hostRuntimeCapabilities(entry.processor, { now }),
      };
    },
  };
}

/**
 * The two live capabilities every processor host hands the stream alongside
 * its sink, built in ONE place so the server host and the browser runtime
 * cannot drift:
 *
 * - `getRuntimeState` merges the processor's self-measured metrics into the
 *   answer HERE — outside the processor — so a subclass that overrides
 *   `getRuntimeState` with its own `runtime` bag cannot accidentally drop
 *   them.
 * - `ping` answers the mutual ping (see rpc-types.ts) and — only when the
 *   host measures its transport RTT (`oneWayEstimateMs`, the browser's
 *   half-RTT) — feeds the observed timestamps into the processor's
 *   clock-offset estimate. A host that omits it shares the stream's clock
 *   domain, where the correct offset IS zero: recording the raw `t1 − t0`
 *   there would book transport delay as clock skew and bias delivery ages.
 *   A host with no RTT sample yet skips too — an uncorrected offset guess
 *   is worse than the documented raw-age estimate.
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
