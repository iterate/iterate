// subscription-forwarder-processor.ts — THE ABSENT-TARGET DELIVERY LANE: one built-in
// facet-hosted processor that serves every subscription mount whose target is NOT a connected
// client (webhooks, stateless workers, arbitrary itx expressions). Auto-enabled by the parent
// the first time such a mount is provided.
//
// Division of labor (the increment-56 shape):
//   • CONNECTED targets (`itx.connections.get(…)`) never come here — the parent fire-and-forgets
//     batches down the delivery WebSocket from the commit path, keeping ZERO per-row state.
//   • ABSENT targets need what a socket gives connected ones for free — ordering, backpressure,
//     at-least-once — so THIS processor holds a SubscriptionDeliveryProgress cursor per mount
//     in its own facet storage and pumps: read a batch from the cursor, apply the consumes
//     filter, call the target with `(events, scannedOffsetRange)` (the awaited call IS the ack),
//     advance.
//
// ONE failure policy — bounded-retry-then-halt (skip/pinning died with increment 56): a failed
// delivery retries with 1s·2^n backoff (cap 30 min, ±20% jitter) up to `maxAttempts` (default
// 15), then HALTS the subscription with an audit event on the stream. `resumeSubscription({
// name, afterOffset? })` is the one recovery verb. Facets have no alarms (workerd#6810), so
// retries are armed THROUGH the parent (`armSubscriptionRetry`), whose alarm calls
// `pumpSubscriptionDeliveries()` back when due. Delivery itself also rides the parent
// (`deliverToSubscriptionMount`) BY ROW IDENTITY, never by name through the table — a broad
// default route must not intercept deliveries.

import { z } from "zod";
import { defineProcessorContract } from "./core/events.ts";
import { StreamProcessor, type ProcessEventArgs, type ReduceArgs } from "./core/processor.ts";
import type { FacetProcessorArgs } from "./processor-facet.ts";

/** One absent-target subscription mount, as this processor's reduce sees it (string-at-rest
 *  halves straight from the capability-provided payload). */
const AbsentTargetSubscriptionMount = z.object({
  name: z.string(),
  providedAtOffset: z.number(),
  target: z.string(),
  consumes: z.array(z.string()).optional(),
  maxAttempts: z.number().optional(),
  start: z.enum(["beginning", "now"]).optional(),
});
type AbsentTargetSubscriptionMount = z.infer<typeof AbsentTargetSubscriptionMount>;

const SubscriptionForwarderContract = defineProcessorContract({
  slug: "subscription-forwarder",
  version: "1.0.0",
  description:
    "Delivers event batches to absent subscription targets (webhooks, itx expressions) with a per-target cursor and the one bounded-retry-then-halt policy.",
  stateSchema: z.object({
    subscriptionMounts: z.array(AbsentTargetSubscriptionMount).default([]),
  }),
  events: {},
  consumes: [
    "events.iterate.com/capability-table/capability-provided",
    "events.iterate.com/capability-table/capability-revoked",
  ],
  emits: ["events.iterate.com/stream/subscription-delivery-halted"],
});

type ForwarderState = { subscriptionMounts: AbsentTargetSubscriptionMount[] };

/** The per-mount delivery cursor + failure ladder, in this facet's OWN storage (key
 *  `subscription-delivery-progress:<providedAtOffset>`). `rev` is the surgery generation:
 *  resumeSubscription bumps it, and an in-flight pump that read the OLD record must not clobber
 *  the surgical one. */
type SubscriptionDeliveryProgress = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  halted?: { reason: string };
  rev?: number;
};

/** The served rows: per name, the NEWEST provide wins (the shadow stack, projected). A shadowed
 *  row's progress freezes under its own providedAtOffset; revoke pops and it resumes there. */
const activeMounts = (state: ForwarderState): AbsentTargetSubscriptionMount[] => {
  const byName = new Map<string, AbsentTargetSubscriptionMount>();
  for (const m of state.subscriptionMounts) {
    const cur = byName.get(m.name);
    if (!cur || m.providedAtOffset > cur.providedAtOffset) byName.set(m.name, m);
  }
  return [...byName.values()];
};

export class SubscriptionForwarderProcessor extends StreamProcessor<ForwarderState> {
  readonly contract = SubscriptionForwarderContract;
  readonly #deliveryStorage: FacetProcessorArgs["storage"];
  readonly #parent: FacetProcessorArgs["parent"];
  /** One pump per row at a time — in memory only (a dropped pump re-runs from the cursor). */
  #deliveriesInFlight = new Set<number>();

  constructor(args: FacetProcessorArgs) {
    super(args);
    this.#deliveryStorage = args.storage;
    this.#parent = args.parent;
  }

  protected override reduce({ event, state }: ReduceArgs<ForwarderState>) {
    if (event.type === "events.iterate.com/capability-table/capability-provided") {
      const { path, target, delivery } = event.payload as {
        path: string;
        target: string;
        delivery?: {
          consumes?: string[];
          maxAttempts?: number;
          start?: "beginning" | "now";
          liveState?: unknown;
        };
      };
      const segments = path.split(".");
      if (segments.length !== 3 || segments[0] !== "itx" || segments[1] !== "subscribers")
        return undefined;
      // Connected targets are the parent's lane; liveState never reaches an absent target
      // (rejected at provide — this guard is the reduce's belt for raw appended events).
      if (/^itx\.connections\.get\(/.test(target.trim()) || delivery?.liveState) return undefined;
      return {
        subscriptionMounts: [
          ...state.subscriptionMounts,
          {
            name: segments[2],
            providedAtOffset: event.offset,
            target,
            ...(delivery?.consumes ? { consumes: delivery.consumes } : {}),
            ...(delivery?.maxAttempts !== undefined ? { maxAttempts: delivery.maxAttempts } : {}),
            ...(delivery?.start ? { start: delivery.start } : {}),
          },
        ],
      };
    }
    if (event.type === "events.iterate.com/capability-table/capability-revoked") {
      const { providedAtOffset } = event.payload as { providedAtOffset: number };
      if (!state.subscriptionMounts.some((m) => m.providedAtOffset === providedAtOffset))
        return undefined;
      return {
        subscriptionMounts: state.subscriptionMounts.filter(
          (m) => m.providedAtOffset !== providedAtOffset,
        ),
      };
    }
    return undefined;
  }

  protected override processEvent({ event, state, delivery }: ProcessEventArgs<ForwarderState>) {
    if (event?.type === "events.iterate.com/capability-table/capability-revoked") {
      // Revoke doubles as cursor GC (the reduce above already dropped the row).
      const { providedAtOffset } = event.payload as { providedAtOffset: number };
      this.#deliveryStorage.delete?.(this.#progressKey(providedAtOffset));
    }
    if (delivery.caughtUp && state.subscriptionMounts.length > 0)
      // Rule 3 (runInBackground semantics, spelled directly): a droppable pump attempt whose
      // outcome is recoverable from the cursor at the next at-head pass.
      void this.pumpSubscriptionDeliveries().catch((e) =>
        console.error("subscription-forwarder pump failed", e),
      );
    return undefined;
  }

  /** Pump every active row once (each serialized per row, all rows concurrent). The parent's
   *  alarm calls this when a retry comes due; the at-head pass calls it after every batch. */
  async pumpSubscriptionDeliveries(): Promise<{ ok: true }> {
    const { state } = await this.snapshot();
    await Promise.allSettled(activeMounts(state).map((row) => this.#pumpRow(row)));
    return { ok: true };
  }

  /** THE one recovery verb: clear the failure state (halt included), optionally move the
   *  cursor, pump. */
  async resumeSubscription(input: { name: string; afterOffset?: number }): Promise<{ ok: true }> {
    const { state } = await this.snapshot();
    const row = activeMounts(state).find((r) => r.name === input.name);
    if (!row) throw new Error(`subscription-forwarder: no subscription "${input.name}"`);
    const progress = this.#progress(row.providedAtOffset);
    this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), {
      confirmedOffset: input.afterOffset ?? progress?.confirmedOffset ?? row.providedAtOffset,
      attempt: 0,
      rev: (progress?.rev ?? 0) + 1, // the surgery generation — in-flight pump writes lose to this
    } satisfies SubscriptionDeliveryProgress);
    void this.#pumpRow(row).catch((e) =>
      console.error(`subscription "${input.name}" pump after resume failed`, e),
    );
    return { ok: true };
  }

  #progressKey(providedAtOffset: number): string {
    return `subscription-delivery-progress:${providedAtOffset}`;
  }
  #progress(providedAtOffset: number): SubscriptionDeliveryProgress | undefined {
    return this.#deliveryStorage.get<SubscriptionDeliveryProgress>(
      this.#progressKey(providedAtOffset),
    );
  }

  /** One in-flight delivery per row; loop until caught up. */
  async #pumpRow(row: AbsentTargetSubscriptionMount): Promise<void> {
    if (this.#deliveriesInFlight.has(row.providedAtOffset)) return;
    this.#deliveriesInFlight.add(row.providedAtOffset);
    try {
      for (;;) {
        // Shadowed or revoked mid-flight → the cursor freezes NOW, not when the pump happens
        // to drain (the shadow's whole meaning is that the OLD target stops receiving).
        const { state } = await this.snapshot();
        if (!activeMounts(state).some((r) => r.providedAtOffset === row.providedAtOffset)) return;
        let progress = this.#progress(row.providedAtOffset);
        if (!progress) {
          // Minted LAZILY on first pump — rows are derived from the reduce, nothing mints them.
          progress = {
            confirmedOffset: row.start === "beginning" ? 0 : row.providedAtOffset,
            attempt: 0,
          };
          this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), progress);
        }
        if (progress.halted) return;
        if (progress.nextAttemptAtMs && Date.now() < progress.nextAttemptAtMs) {
          await this.#parent().armSubscriptionRetry({ atMs: progress.nextAttemptAtMs });
          return;
        }
        const page = await this.stream.read(progress.confirmedOffset, 100);
        if (page.scannedThroughOffset <= progress.confirmedOffset) return; // caught up
        const scannedOffsetRange = {
          scannedAfterOffset: progress.confirmedOffset,
          scannedThroughOffset: page.scannedThroughOffset,
        };
        const events = row.consumes
          ? page.events.filter((e) => row.consumes!.includes(e.type))
          : page.events;
        if (events.length === 0) {
          // everything in the range was filtered — confirm through it, no call
          this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), {
            ...progress,
            confirmedOffset: scannedOffsetRange.scannedThroughOffset,
          });
          continue;
        }
        // The awaited call IS the ack. The watchdog timer is CLEARED on the happy path — a
        // leaked 20s timer per delivery pins the facet's isolate for nothing.
        let deliveryWatchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.#parent().deliverToSubscriptionMount({
              providedAtOffset: row.providedAtOffset,
              args: [events, scannedOffsetRange],
            }),
            new Promise((_, reject) => {
              deliveryWatchdog = setTimeout(
                () => reject(new Error(`subscription "${row.name}": delivery timed out after 20s`)),
                20_000,
              );
            }),
          ]);
          // Compare-and-swap on the surgery generation: if resumeSubscription rewrote the
          // record while we were delivering, the surgical cursor wins (the delivered batch may
          // redeliver — exactly what a replay request asks for).
          const fresh = this.#progress(row.providedAtOffset);
          if ((fresh?.rev ?? 0) !== (progress.rev ?? 0)) continue;
          this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), {
            confirmedOffset: scannedOffsetRange.scannedThroughOffset,
            attempt: 0,
            rev: progress.rev,
          } satisfies SubscriptionDeliveryProgress);
        } catch (error) {
          await this.#onDeliveryFailure(row, progress, error);
          return;
        } finally {
          if (deliveryWatchdog !== undefined) clearTimeout(deliveryWatchdog);
        }
      }
    } finally {
      this.#deliveriesInFlight.delete(row.providedAtOffset);
    }
  }

  /** The ONE policy: bounded retries (1s·2^n, cap 30 min, ±20% jitter, `maxAttempts` total —
   *  default 15) then HALT with an audit event. A target outage and a poison batch ride the
   *  same predictable ladder; the operator's answer to both is resumeSubscription. */
  async #onDeliveryFailure(
    row: AbsentTargetSubscriptionMount,
    progress: SubscriptionDeliveryProgress,
    error: unknown,
  ): Promise<void> {
    // The same CAS as the success path: surgery or revoke mid-delivery wins over the failure.
    const fresh = this.#progress(row.providedAtOffset);
    if ((fresh?.rev ?? 0) !== (progress.rev ?? 0)) return;
    const attempt = progress.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempt >= (row.maxAttempts ?? 15)) {
      const reason = `${attempt} delivery attempts failed (last: ${message})`;
      this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), {
        confirmedOffset: progress.confirmedOffset,
        attempt: 0,
        halted: { reason },
        rev: progress.rev,
      } satisfies SubscriptionDeliveryProgress);
      await this.stream.append({
        type: "events.iterate.com/stream/subscription-delivery-halted",
        payload: { name: row.name, reason },
      });
      return;
    }
    const jittered = Math.round(
      Math.min(1000 * 2 ** (attempt - 1), 1_800_000) * (0.8 + Math.random() * 0.4),
    );
    const nextAttemptAtMs = Date.now() + jittered;
    this.#deliveryStorage.put(this.#progressKey(row.providedAtOffset), {
      ...progress,
      attempt,
      nextAttemptAtMs,
    } satisfies SubscriptionDeliveryProgress);
    await this.#parent().armSubscriptionRetry({ atMs: nextAttemptAtMs });
  }
}
