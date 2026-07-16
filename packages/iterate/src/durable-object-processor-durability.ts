// The Cloudflare Durable Object implementations of the StreamProcessorRunner's
// two durability adapters (stream-processor-runner.ts):
//
//   - `durableObjectProgressStore` — the CAS-fenced two-cursor
//     {@link ProcessorProgressStore} over the DO's synchronous KV facade.
//   - `durableObjectRecovery` — the {@link ProcessorRecovery} adapter for a
//     durable processor that owns background work: ONE ProcessorKeepalive per
//     runner, storage-backed per-slug, with the DO-shaped seams (alarm slice,
//     waitUntil) INJECTED so nothing here touches `storage.setAlarm` or a
//     Cloudflare ctx directly.
//
// This file is deliberately runtime-light so its tests run in plain-node
// vitest over an in-memory `storage.kv` fake
// (durable-object-processor-durability.test.ts).

import type { Stream } from "./itx-api.generated.js";
import { ProcessorKeepalive, type KeepaliveRecord } from "./stream-processor-keepalive.js";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "./stream-processor-revival.js";
import type {
  ProcessorProgress,
  ProcessorProgressStore,
  ProcessorRecovery,
} from "./stream-processor-runner.js";

// -----------------------------------------------------------------------------
// Key layout. Per-slug, all under the `stream-processor:` prefix.
// -----------------------------------------------------------------------------

/** The two-cursor progress record ({@link ProcessorProgress}). */
export const processorProgressKey = (slug: string) => `stream-processor:${slug}:progress`;

/** The per-runner keepalive record ({@link KeepaliveRecord}). */
export const processorKeepaliveKey = (slug: string) => `stream-processor:${slug}:keepalive`;

/**
 * The runner's durable progress store over DO KV (`storage.kv` — synchronous,
 * single-threaded isolate, so read-check-write is atomic without awaits).
 */
export function durableObjectProgressStore<State>(args: {
  storage: DurableObjectStorage;
  slug: string;
}): ProcessorProgressStore<State> {
  const { storage, slug } = args;
  const progressKey = processorProgressKey(slug);

  return {
    read: () => storage.kv.get<ProcessorProgress<State>>(progressKey),
    commit: (progress, opts) => {
      // CAS fence: read-check-write with NO intervening awaits — DO storage is
      // synchronous and the isolate single-threaded, so this whole block is
      // atomic. An absent record reads as revision 0.
      const persisted = storage.kv.get<ProcessorProgress<State>>(progressKey);
      const persistedRevision = persisted?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persistedRevision) {
        throw new Error(
          `stream processor "${slug}" progress commit fenced: expected cursorRevision ` +
            `${opts.expectedCursorRevision}, persisted ${persistedRevision} — ` +
            `a cursor rewind landed after this continuation began`,
        );
      }
      // MONOTONIC fence: the revision CAS alone cannot stop a stale
      // incarnation at the SAME revision from rolling acknowledgement (and
      // state) backward past progress a newer incarnation already committed —
      // re-running effects that were durably acknowledged. Only an explicit
      // revision-bumping cursor rewind may move acked backward.
      if (
        persisted !== undefined &&
        progress.processing.acknowledgedThroughOffset <
          persisted.processing.acknowledgedThroughOffset &&
        progress.processing.cursorRevision <= persistedRevision
      ) {
        throw new Error(
          `stream processor "${slug}" progress commit fenced: acknowledgedThroughOffset would ` +
            `move backward (${persisted.processing.acknowledgedThroughOffset} -> ` +
            `${progress.processing.acknowledgedThroughOffset}) without a cursorRevision bump — ` +
            `a stale incarnation is rolling the cursor back`,
        );
      }
      storage.kv.put(progressKey, progress);
    },
  };
}

/**
 * The runner's recovery adapter for a Durable Object: wraps ONE
 * {@link ProcessorKeepalive} for THIS runner (per-runner recovery identity, so
 * a revival names exactly which processor owed work). The keepalive machinery
 * — mark-before-work, bounded backoff, quiet-clean reset,
 * deploy-version reset, wedged-work detection — is reused wholesale, never
 * reimplemented.
 *
 * DO-shaped seams are INJECTED, not reached for:
 *   - `armAlarm` — the hosting registry's alarm slice for this runner. A DO
 *     has ONE alarm; the registry merges every runner's desire (plus its own)
 *     and arms the earliest, exactly like the host's `setAlarmSlice`. This
 *     adapter never touches `storage.setAlarm`.
 *   - `waitUntil` — the hosting DO's `ctx.waitUntil` lane, keeping the
 *     incarnation alive while tracked work runs.
 *
 * Revival appends the core `stream/processor-revived` fact (ONE type for
 * every processor — {@link STREAM_PROCESSOR_REVIVED_EVENT_TYPE}; the payload's
 * `processorSlug` and the idempotency key carry the per-processor identity)
 * to the stream and STOPS: the append wakes the stream's subscription spine (its
 * `woken` fan-out cold-boots the stream DO if the deploy evicted it too), and
 * the ordinary wake-mode delivery of that fact is the guaranteed turn that
 * runs the processor's own reconciliation — the runner's construction check
 * enforces that the contract consumes it. No self-driven catch-up here,
 * unlike the host's `catchUpInternal` loop: delivery has ONE entrypoint.
 *
 * Construction re-issues a persisted armed desire through `armAlarm` (the
 * host's boot-time reconcile): a platform `setAlarm` that failed after the KV
 * record committed — or an eviction in the fire→re-arm window — would
 * otherwise leave the only thing that revives this DO permanently lost.
 */
export function durableObjectRecovery(args: {
  storage: DurableObjectStorage;
  /** The processor's contract slug — keys the per-runner keepalive record. */
  slug: string;
  /** The processor's home stream: revived facts and crash-loop evidence land here. */
  stream: Stream;
  /** Worker deploy version; a change resets the keepalive's crash-loop budget
   * (the antidote deploy). Pass `workerVersion(env)`. REQUIRED for the same
   * reason the host requires it: a silent default could never take the
   * version-reset lane. */
  version: string;
  /** The registry's alarm-slice seam for this runner (null = disarm). */
  armAlarm: (atMs: number | null) => void;
  /** The hosting DO's `ctx.waitUntil` — keeps the incarnation alive while
   * tracked work runs. */
  waitUntil: (work: Promise<unknown>) => void;
  /** Injected clock for the test harness; production uses Date.now. */
  now?: () => number;
}): ProcessorRecovery {
  const now = args.now ?? (() => Date.now());
  const recordKey = processorKeepaliveKey(args.slug);
  const readRecord = () => args.storage.kv.get<KeepaliveRecord>(recordKey);

  const recovery: ProcessorRecovery = {
    // The host's wiring verbatim (stream-processor-host.ts:445): every
    // registered closure — blocking, background, and the runner's whole-frame
    // attempt — rides the keepalive, so "the DO died owing work" is exactly
    // "the DO died with the alarm armed".
    keepAliveWhile: (work) => keepalive.track(work()),
    appendRevived: async () => {
      // Keyed per revival ATTEMPT: the keepalive durably marks the record
      // (revivals+1, lastRevivalAt=now) BEFORE its revive hook runs, so this
      // read names the current attempt. A platform retry of the same attempt
      // dedupes; distinct attempts journal distinct facts — the same
      // derivation as the host's `processor-host-revived@...` key, per-slug.
      const record = readRecord();
      await args.stream.append({
        type: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
        idempotencyKey:
          `processor-revived:${args.slug}` +
          `@${record?.version ?? args.version}:${record?.revivals ?? 0}:${record?.lastRevivalAt ?? 0}`,
        payload: {
          processorSlug: args.slug,
          revivals: record?.revivals ?? 0,
          version: record?.version ?? args.version,
        },
      });
    },
    handleAlarm: async () => {
      // Delegation IS the whole handler: every alarm action drives the
      // injected seams from inside onAlarm before it returns — busy_rearmed
      // re-arms at the lead, clean_disarmed disarms via armAlarm(null), the
      // revival lanes mark + arm the backoff and run the revive hook (which
      // appends the revived fact). The keepalive self-gates on its persisted
      // armed time, so a fire belonging to another slice of the shared DO
      // alarm is a no-op here — route every fire to every runner.
      await keepalive.onAlarm();
    },
  };

  const keepalive = new ProcessorKeepalive({
    now,
    readRecord,
    writeRecord: (record) => args.storage.kv.put(recordKey, record),
    armAlarm: (atMs) => args.armAlarm(atMs),
    keepAlive: (work) => args.waitUntil(work),
    // Append the journaled fact and stop — the wake delivery of that fact is
    // the recovery turn. Failures throw: the keepalive's breaker owns retries.
    revive: async () => {
      await recovery.appendRevived();
    },
    // Best-effort journal evidence (crash-loop warnings). Must not throw.
    appendFact: (event) => {
      void Promise.resolve(args.stream.append(event)).catch((error: unknown) => {
        console.error(`stream processor "${args.slug}" keepalive evidence append failed`, error);
      });
    },
    version: args.version,
  });

  // Boot-time reconcile (the host's post-construction block verbatim): a
  // fresh incarnation restores — and RE-ISSUES — the persisted alarm desire,
  // so a lost platform alarm heals on the next dial instead of never.
  const persisted = readRecord();
  if (persisted !== undefined && persisted.armedAtMs !== null) {
    args.armAlarm(persisted.armedAtMs);
  }

  return recovery;
}
