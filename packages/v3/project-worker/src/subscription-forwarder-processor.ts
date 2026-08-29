// subscription-forwarder-processor.ts — THE ABSENT-TARGET DELIVERY LANE: one built-in
// facet-hosted processor serving every subscription mount whose target is NOT a connected
// client (webhooks, stateless workers, arbitrary itx expressions). Auto-enabled by the parent
// the first time such a mount is provided. CONNECTED targets never come here — the parent
// fire-and-forgets batches over the paged-in hibernatable RPC stub straight from the commit
// path, keeping ZERO per-row state.
//
// THE PROCESSOR IDIOM, deliberately: a contract, TWO SWITCHES (reduce = which subscription
// mounts exist; processEvent = what to do about it), and ONE declared dependency — the
// SubscriptionDeliveryPump below, which owns all delivery mechanics. Everything the processor
// does rides the log: mounts arrive as capability-provided/-revoked facts, operator recovery
// arrives as a subscription-resumed fact (appended by the parent's resumeSubscription verb),
// halts leave a subscription-delivery-halted audit fact. The ONE entry that can never be an
// event is pumpSubscriptionDeliveries() — facets have no alarms (workerd#6810), so the parent's
// alarm calls it when a retry backoff comes due.
//
// WHERE STATE LIVES (the rule, stated once): reduce state = the subscription mounts — it MUST
// rebuild bit-identically from the durable log. SubscriptionDeliveryProgress = how far each
// target has ACKED — that is effect-side truth (a replay must never un-deliver), so it lives in
// this facet's own storage, injected into the pump as `progress`.

import { z } from "zod";
import { defineProcessorContract } from "./core/events.ts";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScannedOffsetRange,
} from "./core/processor.ts";
import type { StreamEvent } from "./core/events.ts";
import { consumesEvent } from "./core/processor.ts";
import type { FacetProcessorArgs } from "./processor-facet.ts";
import { reportIssue } from "./core/errors.ts";

/** One absent-target subscription mount, as the reduce sees it (string-at-rest halves straight
 *  from the capability-provided payload). */
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
  version: "2.0.0", // 2.0.0: subscription-resumed rides the log (the facet verb died)
  description:
    "Delivers event batches to absent subscription targets with a per-target cursor and the one bounded-retry-then-halt policy.",
  stateSchema: z.object({
    subscriptionMounts: z.array(AbsentTargetSubscriptionMount).default([]),
  }),
  events: {},
  consumes: [
    "events.iterate.com/capability-table/capability-provided",
    "events.iterate.com/capability-table/capability-revoked",
    "events.iterate.com/stream/subscription-resumed",
  ],
  emits: ["events.iterate.com/stream/subscription-delivery-halted"],
});

type ForwarderState = { subscriptionMounts: AbsentTargetSubscriptionMount[] };

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
  // Every delivery mechanic — cursor read-loop, watchdog, backoff ladder, halt — lives on THIS
  // class (no injected pump: the collaborators are the ones the processor already holds).
  readonly #parent: FacetProcessorArgs["parent"];
  readonly #storage: FacetProcessorArgs["storage"];
  readonly #deliveriesInFlight = new Set<number>();

  constructor(args: FacetProcessorArgs) {
    super(args);
    this.#parent = args.parent;
    this.#storage = args.storage;
  }

  // ── the per-mount delivery cursor + failure ladder record (facet storage, keyed by offset) ──
  #progress(off: number): SubscriptionDeliveryProgress | undefined {
    return this.#storage.get(`subscription-delivery-progress:${off}`) as
      | SubscriptionDeliveryProgress
      | undefined;
  }
  #putProgress(off: number, record: SubscriptionDeliveryProgress): void {
    this.#storage.put(`subscription-delivery-progress:${off}`, record);
  }

  protected override reduce({ event, state }: ReduceArgs<ForwarderState>) {
    switch (event.type) {
      case "events.iterate.com/capability-table/capability-provided": {
        const { path, target, delivery } = event.payload as {
          path: string;
          target: string;
          delivery?: Partial<AbsentTargetSubscriptionMount> & { liveState?: unknown };
        };
        const segments = path.split(".");
        if (segments.length !== 3 || segments[0] !== "itx" || segments[1] !== "subscribers")
          return undefined;
        // Connected (rpc-stub) targets are the parent's lane; FACET targets are the pump's lane (a
        // processor is a facet-target subscriber — including this forwarder itself); liveState never
        // reaches an absent target (rejected at provide — this guard is the reduce's belt for raw
        // appends). THESE TWO NOUNS MUST TRACK rpcStubTarget/facetTarget in stream-durable-object.ts
        // (this is a separate string-side copy across the facet-bundle boundary — a rename of either
        // noun there MUST be mirrored here, or the two lanes disagree and double-deliver).
        const t = target.trim();
        if (/^itx\.rpcStubs\.get\(/.test(t) || /^itx\.facets\.get\(/.test(t) || delivery?.liveState)
          return undefined;
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
      case "events.iterate.com/capability-table/capability-revoked": {
        const { providedAtOffset } = event.payload as { providedAtOffset: number };
        if (!state.subscriptionMounts.some((m) => m.providedAtOffset === providedAtOffset))
          return undefined;
        return {
          subscriptionMounts: state.subscriptionMounts.filter(
            (m) => m.providedAtOffset !== providedAtOffset,
          ),
        };
      }
      default:
        return undefined; // subscription-resumed changes no reduce state — it is a pump command
    }
  }

  protected override processEvent({ event, state, delivery }: ProcessEventArgs<ForwarderState>) {
    switch (event?.type) {
      case "events.iterate.com/capability-table/capability-revoked":
        // Revoke doubles as cursor GC (the reduce above already dropped the row).
        this.#storage.delete?.(
          `subscription-delivery-progress:${(event.payload as { providedAtOffset: number }).providedAtOffset}`,
        );
        break;
      case "events.iterate.com/stream/subscription-resumed": {
        const { name, afterOffset } = event.payload as { name: string; afterOffset?: number };
        const row = activeMounts(state).find((r) => r.name === name);
        if (row) this.#reset(row, afterOffset);
        break;
      }
      default:
        break;
    }
    if (delivery.caughtUp && state.subscriptionMounts.length > 0)
      // Rule 3 (runInBackground semantics, spelled directly): a droppable pump attempt whose
      // outcome is recoverable from the cursors at the next at-head pass.
      void this.pumpSubscriptionDeliveries().catch((e) =>
        reportIssue("subscription-forwarder.pump", e),
      );
    return undefined;
  }

  /** The one non-event entry (facets have no alarms — workerd#6810): the parent's alarm calls this
   *  when a retry backoff comes due. Pump every active row once (serialized per row, concurrent
   *  across rows — the ONE failure policy: bounded retries 1s·2^n, cap 30 min, ±20% jitter,
   *  `maxAttempts` total default 15, then HALT + audit fact). */
  async pumpSubscriptionDeliveries(): Promise<{ ok: true }> {
    const { state } = await this.snapshot();
    await Promise.allSettled(activeMounts(state).map((row) => this.#pumpRow(row)));
    return { ok: true };
  }

  /** The subscription-resumed command: clear the failure state (halt included), optionally move the
   *  cursor, pump. The rev bump makes any in-flight delivery's writes lose. */
  #reset(row: AbsentTargetSubscriptionMount, afterOffset?: number): void {
    const progress = this.#progress(row.providedAtOffset);
    this.#putProgress(row.providedAtOffset, {
      confirmedOffset: afterOffset ?? progress?.confirmedOffset ?? row.providedAtOffset,
      attempt: 0,
      rev: (progress?.rev ?? 0) + 1,
    });
    void this.#pumpRow(row).catch((e) =>
      reportIssue("subscription-forwarder.reset-pump", e, { subscriptionName: row.name }),
    );
  }

  async #pumpRow(row: AbsentTargetSubscriptionMount): Promise<void> {
    if (this.#deliveriesInFlight.has(row.providedAtOffset)) return;
    this.#deliveriesInFlight.add(row.providedAtOffset);
    try {
      for (;;) {
        let progress = this.#progress(row.providedAtOffset);
        if (!progress) {
          // Minted LAZILY on first pump — rows are derived from the reduce, nothing mints them.
          progress = {
            confirmedOffset: row.start === "beginning" ? 0 : row.providedAtOffset,
            attempt: 0,
          };
          this.#putProgress(row.providedAtOffset, progress);
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
        const events = page.events.filter((e) => consumesEvent(row.consumes, e));
        if (events.length === 0) {
          // everything in the range was filtered — confirm through it, no call
          this.#putProgress(row.providedAtOffset, {
            ...progress,
            confirmedOffset: scannedOffsetRange.scannedThroughOffset,
          });
          continue;
        }
        // The awaited call IS the ack. The watchdog is CLEARED on the happy path — a leaked 20s
        // timer per delivery pins the facet's isolate for nothing.
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
          // CAS on the reset generation: if a subscription-resumed landed while we were delivering,
          // the reset cursor wins (the delivered batch may redeliver — exactly what a replay asks).
          const fresh = this.#progress(row.providedAtOffset);
          // Revoked mid-delivery → the record was deleted; abandon (never re-mint it, which would
          // resurrect the row and try to deliver the revoke fact itself — the ghost halt).
          if (fresh === undefined) return;
          if ((fresh.rev ?? 0) !== (progress.rev ?? 0)) continue;
          this.#putProgress(row.providedAtOffset, {
            confirmedOffset: scannedOffsetRange.scannedThroughOffset,
            attempt: 0,
            rev: progress.rev,
          });
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

  async #onDeliveryFailure(
    row: AbsentTargetSubscriptionMount,
    progress: SubscriptionDeliveryProgress,
    error: unknown,
  ): Promise<void> {
    // The same CAS as the success path: a reset (or revoke) mid-delivery wins over the failure.
    // A DELETED record means the row was revoked — abandon silently, NO spurious halt audit fact.
    const fresh = this.#progress(row.providedAtOffset);
    if (fresh === undefined || (fresh.rev ?? 0) !== (progress.rev ?? 0)) return;
    const attempt = progress.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    // Honor stamped flags over an invented taxonomy (the core/errors.ts doctrine): an error
    // carrying `retryable: false` (workerd stamps these; providers may too) will never succeed —
    // burning the ladder on it just delays the halt by half an hour.
    const neverRetryable =
      typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      (error as { retryable: unknown }).retryable === false;
    if (neverRetryable || attempt >= (row.maxAttempts ?? 15)) {
      const reason = neverRetryable
        ? `delivery failed with retryable: false (${message})`
        : `${attempt} delivery attempts failed (last: ${message})`;
      this.#putProgress(row.providedAtOffset, {
        confirmedOffset: progress.confirmedOffset,
        attempt: 0,
        halted: { reason },
        rev: progress.rev,
      });
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
    this.#putProgress(row.providedAtOffset, { ...progress, attempt, nextAttemptAtMs });
    await this.#parent().armSubscriptionRetry({ atMs: nextAttemptAtMs });
  }
}

// ── the per-mount delivery cursor + failure record ──

/** The per-mount delivery cursor + failure ladder record (facet storage, keyed by the mount's
 *  providedAtOffset). `rev` is the reset generation: an in-flight delivery that started before
 *  a reset must not clobber the reset cursor (compare-and-swap before every write). */
type SubscriptionDeliveryProgress = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  halted?: { reason: string };
  rev?: number;
};
