// The browser stream mirror downloads a stream ONCE and fans every delivered
// frame out to a fixed canonical set of processors (see
// canonical-mirror-processors.ts). This composite is the drive-side unit that
// owns the fan-out under StreamProcessorRunner drive: one runner PER MEMBER
// (each with its own transactional progress store — projection writes and the
// two-cursor record commit in ONE SQLite transaction per member,
// processor-state-storage.ts), one `openDelivery()` for the runtime, whose
// sink fans each frame to every member's sink IN CANONICAL ORDER.
//
// Why fan-out is safe: each member's runner offset-dedupes delivered events
// against its own durable ACKNOWLEDGED cursor (stream-processor-runner.ts
// #processFrame), so the shared replay cursor is just the MINIMUM member
// checkpoint and a member that is ahead cheaply no-ops on frames it already
// committed. This is the same over-delivery guarantee the legacy composite
// leaned on (`StreamProcessor` skipping events <= its checkpoint), one level
// up: the runner owns the cursor now, so the dedupe lives there.
//
// Why fan-out is SEQUENTIAL: the members share one OPFS SQLite connection,
// and each member's frame commit is one `sql.batch(..., { transaction: true })`.
// Driving members one after another means their commit transactions can never
// interleave on that shared connection, and a rejecting member propagates
// AFTER the earlier members' commits landed — the runtime's self-heal then
// resubscribes from the (new minimum) checkpoint and replays for every
// member; the ahead members' runners dedupe the replay.

import { z } from "zod";
import type { StreamEvent } from "../../schemas.ts";
import type { AnyHostedProcessor } from "../../processor-host-capabilities.ts";
import type { StreamProcessorRunner } from "../../stream-processor-runner.ts";
import type { ProcessorSnapshot } from "../../rpc-types.ts";

/** One canonical mirror member: its stable slug, the hosted processor
 * instance (contract, metrics, runtime bag), and the runner that drives it. */
type CompositeMirrorMember = {
  slug: string;
  processor: AnyHostedProcessor;
  // The members are heterogeneous (each runner is generic in its own
  // contract), so the composite holds them type-erased.
  runner: StreamProcessorRunner<any>;
};

/** One delivered transport frame, as the runtime's sink receives it. */
type MirrorFrame = { events: readonly StreamEvent[]; streamMaxOffset: number };

/**
 * Fans the single mirror download out to an ordered set of member runners.
 * The first member is the PRIMARY: it bears the reported subscriber metrics
 * and contributes the runtime bag (see {@link subscriberMetrics}) and should
 * be the one that mirrors every appended event (the raw-events cache), so the
 * consume-own-append loop the runtime feeds actually closes.
 *
 * Implements {@link AnyHostedProcessor} so the runtime's wake-handshake
 * capabilities (`hostRuntimeCapabilities`, `announceContract`) treat the
 * whole mirror as one subscriber — the server subscription never learns
 * about member lists.
 */
export class CompositeMirrorDrive implements AnyHostedProcessor {
  readonly contract: AnyHostedProcessor["contract"];
  readonly #members: readonly CompositeMirrorMember[];
  readonly #primary: CompositeMirrorMember;

  constructor(members: readonly CompositeMirrorMember[]) {
    if (members.length === 0) {
      throw new Error("CompositeMirrorDrive requires at least one member");
    }
    this.#members = members;
    this.#primary = members[0]!;

    // Announce a single synthetic mirror contract to the server subscription.
    // consumes/emits are the union of the members' — both canonical members
    // consume "*", so the one subscription still delivers every event each
    // member needs.
    const consumes = new Set<string>();
    const emits = new Set<string>();
    let events: AnyHostedProcessor["contract"]["events"] = {};
    for (const { processor } of members) {
      for (const type of processor.contract.consumes) consumes.add(type);
      for (const type of processor.contract.emits) emits.add(type);
      events = { ...events, ...processor.contract.events };
    }
    this.contract = {
      slug: "browser-stream-mirror",
      version: "0.1.0",
      description: "Fans the browser stream mirror download out to its canonical processors.",
      // The composite has no fold of its own (each member's runner owns its
      // member's state); the schema exists only to satisfy the hosted shape.
      stateSchema: z.object({}),
      consumes: [...consumes],
      emits: [...emits],
      events,
    };
  }

  /**
   * Metrics are delegated to the primary (raw-events) member rather than
   * aggregated: the runtime feeds `noteAppendCommitted` here and the loop
   * closes when the appended offset is ingested — and every appended event
   * lands in the raw-events cache, so the primary's own committed-frame
   * `noteBatchIngested` (fed by ITS runner) closes it honestly. This measures
   * append→cached latency; the feed fold that runs immediately after is a
   * sub-millisecond local step.
   */
  get subscriberMetrics(): AnyHostedProcessor["subscriberMetrics"] {
    return this.#primary.processor.subscriberMetrics;
  }

  /** The processor-contributed runtime bag — the primary's (the snapshot half
   * comes from {@link snapshot}, assembled by the host capabilities). */
  getRuntimeState(): ReturnType<AnyHostedProcessor["getRuntimeState"]> {
    return this.#primary.processor.getRuntimeState();
  }

  /**
   * Open every member's delivery and answer the runtime's wake handshake:
   * the MINIMUM member checkpoint (so replay covers the least-caught-up
   * member — ahead members dedupe on their own cursors) plus ONE sink that
   * fans each frame to every member's sink sequentially, in canonical order
   * (raw cache first — see the module doc for why sequential).
   */
  async openDelivery(): Promise<{
    checkpointOffset: number;
    sink: (batch: MirrorFrame) => Promise<void>;
  }> {
    const opened: Awaited<ReturnType<StreamProcessorRunner<any>["openDelivery"]>>[] = [];
    for (const member of this.#members) {
      opened.push(await member.runner.openDelivery());
    }
    const checkpointOffset = opened.reduce(
      (min, open) => Math.min(min, open.checkpointOffset),
      Number.POSITIVE_INFINITY,
    );
    return {
      checkpointOffset: Number.isFinite(checkpointOffset) ? checkpointOffset : 0,
      sink: async (batch: MirrorFrame) => {
        // ONE download: the server byte-caps each frame but stamps it with the
        // full raw head, and every runner whose acknowledged cursor lands
        // behind that stamp trails a type-unfiltered self-pull of the tail
        // (stream-processor-runner.ts). Fanned out verbatim, EACH member would
        // independently pull the same tail the (unfiltered, "*"-consuming)
        // server subscription is about to deliver anyway — the remainder
        // crossing the network once per member plus once for the pump. Browser
        // members have no onCaughtUp, so that self-pull buys nothing; re-stamp
        // each fanned frame at its OWN tail so no member enters the
        // behind-head branch. (An EMPTY frame keeps the server stamp — there
        // is no tail-continuation coming for it, so the self-pull IS the
        // catch-up lane.)
        const memberFrame: MirrorFrame = {
          events: batch.events,
          streamMaxOffset: batch.events.at(-1)?.offset ?? batch.streamMaxOffset,
        };
        for (const open of opened) {
          await open.sink(memberFrame);
        }
      },
    };
  }

  /**
   * The mirror-level snapshot the wake capability publishes: the MINIMUM
   * member offset (the honest replay cursor — same semantics as
   * {@link openDelivery}). `state` is null: the composite has no fold of its
   * own, and nothing reads the hosted mirror's state through this surface.
   */
  async snapshot(): Promise<ProcessorSnapshot<unknown>> {
    const snapshots = await Promise.all(this.#members.map((member) => member.runner.snapshot()));
    const offset = snapshots.reduce(
      (min, snapshot) => Math.min(min, snapshot.offset),
      Number.POSITIVE_INFINITY,
    );
    return { offset: Number.isFinite(offset) ? offset : 0, state: null };
  }

  /** Dispose every member's runner (election teardown): queued frames and
   * trailing self-pulls reject at their turn instead of racing the next
   * election's drive over the shared mirror. In-flight commits are contained
   * durably by each member's progress-store fences either way. */
  dispose(): void {
    for (const member of this.#members) {
      member.runner.dispose();
    }
  }
}
