// The Cloudflare Durable Object implementations of the StreamProcessorRunner's
// two durability adapters (stream-processor-runner.ts):
//
//   - `durableObjectProgressStore` — the CAS-fenced two-cursor
//     {@link ProcessorProgressStore} over the DO's synchronous KV facade.
//   - `durableObjectRecovery` — the {@link ProcessorRecovery} adapter for a
//     durable processor that owns background work: ONE ProcessorKeepalive per
//     runner, storage-backed per registered NAME, with the DO-shaped seams
//     (alarm slice, waitUntil) INJECTED so nothing here touches
//     `storage.setAlarm` or a Cloudflare ctx directly.
//
// This file is deliberately runtime-light so its tests run in plain-node
// vitest over an in-memory `storage.kv` fake
// (durable-object-processor-durability.test.ts).

import type { ProcessorStream } from "./stream-handle.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "./processor-contracts.ts";
import { isStreamIdMismatchError, StreamIdMismatchError } from "./rpc-types.ts";
import { ProcessorKeepalive, type KeepaliveRecord } from "./stream-processor-keepalive.ts";
import type {
  ProcessorProgress,
  ProcessorProgressStore,
  ProcessorRecovery,
} from "./stream-processor-runner.ts";

// -----------------------------------------------------------------------------
// Key layout. Per registered NAME (the subscription name, which equals the
// contract slug — one identity), all under the `stream-processor:` prefix.
// -----------------------------------------------------------------------------

/** The two-cursor progress record ({@link ProcessorProgress}). */
export const processorProgressKey = (name: string) => `stream-processor:${name}:progress`;

/** The per-runner keepalive record ({@link KeepaliveRecord}). */
export const processorKeepaliveKey = (name: string) => `stream-processor:${name}:keepalive`;

/** A recovery alarm belongs to one stream lifetime, not merely one path. */
type StreamKeepaliveRecord = KeepaliveRecord & { streamId: string };

function isStreamKeepaliveRecord(value: unknown): value is StreamKeepaliveRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StreamKeepaliveRecord>;
  return (
    Number.isInteger(candidate.revivals) &&
    (candidate.revivals ?? -1) >= 0 &&
    typeof candidate.lastRevivalAt === "number" &&
    Number.isFinite(candidate.lastRevivalAt) &&
    typeof candidate.version === "string" &&
    candidate.version.trim().length > 0 &&
    (candidate.armedAtMs === null ||
      (typeof candidate.armedAtMs === "number" && Number.isFinite(candidate.armedAtMs))) &&
    typeof candidate.streamId === "string" &&
    candidate.streamId.trim().length > 0
  );
}

function sameKeepaliveAttempt(
  stored: StreamKeepaliveRecord,
  streamId: string,
  attempt: KeepaliveRecord,
): boolean {
  return (
    stored.streamId === streamId &&
    stored.revivals === attempt.revivals &&
    stored.lastRevivalAt === attempt.lastRevivalAt &&
    stored.version === attempt.version &&
    stored.armedAtMs === attempt.armedAtMs
  );
}

/**
 * The runner's durable progress store over DO KV (`storage.kv` — synchronous,
 * single-threaded isolate, so read-check-write is atomic without awaits).
 */
export function durableObjectProgressStore<State>(args: {
  storage: DurableObjectStorage;
  /** The registered processor name (subscription name = contract slug) —
   * keys the progress record. */
  name: string;
}): ProcessorProgressStore<State> {
  const { storage, name } = args;
  const progressKey = processorProgressKey(name);

  return {
    read: () => storage.kv.get<ProcessorProgress<State>>(progressKey),
    commit: (progress, opts) => {
      // CAS fence: read-check-write with NO intervening awaits — DO storage is
      // synchronous and the isolate single-threaded, so this whole block is
      // atomic. An absent record reads as revision 0.
      const persisted = storage.kv.get<ProcessorProgress<State>>(progressKey);
      if (persisted?.streamId !== opts.expectedStreamId) {
        throw new Error(
          `stream processor "${name}" progress commit fenced: expected stream ID ` +
            `${String(opts.expectedStreamId)}, persisted ${String(persisted?.streamId)} — ` +
            `the stream lifetime changed after this continuation began`,
        );
      }
      const persistedRevision = persisted?.processing.cursorRevision ?? 0;
      if (opts.expectedCursorRevision !== persistedRevision) {
        throw new Error(
          `stream processor "${name}" progress commit fenced: expected cursorRevision ` +
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
          `stream processor "${name}" progress commit fenced: acknowledgedThroughOffset would ` +
            `move backward (${persisted.processing.acknowledgedThroughOffset} -> ` +
            `${progress.processing.acknowledgedThroughOffset}) without a cursorRevision bump — ` +
            `a stale incarnation is rolling the cursor back`,
        );
      }
      storage.kv.put(progressKey, progress);
    },
    replaceForStream: (progress, opts) => {
      const persisted = storage.kv.get<ProcessorProgress<State>>(progressKey);
      if (
        persisted?.streamId !== opts.expectedStreamId ||
        persisted.processing.cursorRevision !== opts.expectedCursorRevision
      ) {
        throw new Error(
          `stream processor "${name}" stream replacement fenced: expected ` +
            `${opts.expectedStreamId}@${opts.expectedCursorRevision}, persisted ` +
            `${String(persisted?.streamId)}@${persisted?.processing.cursorRevision ?? 0}`,
        );
      }
      // Old-lifetime recovery desires must not append revival facts into the
      // recreated stream. A new obligation will arm a fresh record.
      storage.kv.delete(processorKeepaliveKey(name));
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
 *   - `waitUntil` — calls the hosting DO's `ctx.waitUntil`, keeping the
 *     incarnation alive while tracked work runs.
 *
 * Revival appends the core `stream/processor-revived` fact (ONE type for
 * every processor — {@link STREAM_PROCESSOR_REVIVED_EVENT_TYPE}; the payload's
 * `processorSlug` and the idempotency key carry the per-processor identity)
 * to the stream and STOPS: the append wakes the source stream's event sender (its
 * `woken` handlers cold-boot the stream DO if the deploy evicted it too), and
 * wake-mode delivery reaches head and guarantees a turn: either the contract
 * consumes the fact and receives it, or the runner supplies its eventless
 * `processEvent(event: null, caughtUp: true)` pass. No self-driven catch-up
 * here, unlike the host's `catchUpInternal` loop: delivery has ONE entrypoint.
 *
 * Construction re-issues a persisted armed desire through `armAlarm` (the
 * host's boot-time reconcile): a platform `setAlarm` that failed after the KV
 * record committed — or an eviction in the fire→re-arm window — would
 * otherwise leave the only thing that revives this DO permanently lost.
 */
export function durableObjectRecovery(args: {
  storage: DurableObjectStorage;
  /** The registered processor name (subscription name = contract slug) —
   * keys the per-runner keepalive record and the revival fact's idempotency
   * key, and fills the revival payload's `processorSlug`. */
  name: string;
  /** The processor's home stream: revived facts and crash-loop evidence land here. */
  stream: ProcessorStream;
  /** Worker deploy version; a change resets the keepalive's crash-loop budget
   * (the antidote deploy). Pass `workerVersion(env)`. REQUIRED for the same
   * reason the host requires it: a silent default could never take the
   * version-reset code path. */
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
  const recordKey = processorKeepaliveKey(args.name);
  const progressKey = processorProgressKey(args.name);
  const readProgress = () => args.storage.kv.get<ProcessorProgress<unknown>>(progressKey);

  const discardStoredRecord = (reason: string): void => {
    args.storage.kv.delete(recordKey);
    args.armAlarm(null);
    console.warn(`stream processor "${args.name}" discarded its recovery record: ${reason}`);
  };

  const readStoredRecord = (context: string): StreamKeepaliveRecord | undefined => {
    const value = args.storage.kv.get<unknown>(recordKey);
    if (value === undefined) return undefined;
    if (!isStreamKeepaliveRecord(value)) {
      discardStoredRecord(`invalid record found while ${context}`);
      return undefined;
    }
    return value;
  };

  const requireProgressStreamId = (): string => {
    const streamId = readProgress()?.streamId;
    if (streamId === undefined || streamId.trim().length === 0) {
      throw new Error(
        `stream processor "${args.name}" cannot arm recovery before its stream lifetime is bound`,
      );
    }
    return streamId;
  };

  const assertProgressStreamId = (expectedStreamId: string): void => {
    const currentStreamId = readProgress()?.streamId;
    if (currentStreamId !== expectedStreamId) {
      throw new StreamIdMismatchError(
        `stream processor "${args.name}" recovery belongs to stream ID ${expectedStreamId}, ` +
          `but current progress belongs to ${String(currentStreamId)}`,
      );
    }
  };

  const readCurrentStoredRecord = (context: string): StreamKeepaliveRecord | undefined => {
    const record = readStoredRecord(context);
    if (record === undefined) return undefined;
    const progressStreamId = readProgress()?.streamId;
    if (progressStreamId !== record.streamId) {
      discardStoredRecord(
        `record belongs to stream ID ${record.streamId}, current progress belongs to ${String(
          progressStreamId,
        )}`,
      );
      return undefined;
    }
    return record;
  };

  const appendRevived = async (streamId: string, record: KeepaliveRecord): Promise<void> => {
    // Check both sides of the RPC boundary. The progress check stops an old
    // local continuation immediately; appendIfStreamId closes the remaining
    // race if the path is deleted and recreated while the RPC is in flight.
    assertProgressStreamId(streamId);
    await args.stream.appendIfStreamId({
      streamId,
      events: [
        {
          type: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
          idempotencyKey:
            `processor-revived:${args.name}` +
            `@${record.version}:${record.revivals}:${record.lastRevivalAt}`,
          payload: {
            // The registered name IS the contract slug (one identity).
            processorSlug: args.name,
            revivals: record.revivals,
            version: record.version,
          },
        },
      ],
    });
  };

  let activeKeepalive: { streamId: string; keepalive: ProcessorKeepalive } | undefined;

  const keepaliveFor = (streamId: string): ProcessorKeepalive => {
    if (activeKeepalive?.streamId === streamId) return activeKeepalive.keepalive;

    const readRecord = (): KeepaliveRecord | undefined => {
      const record = readCurrentStoredRecord("reading it");
      return record?.streamId === streamId ? record : undefined;
    };
    const keepalive = new ProcessorKeepalive({
      now,
      readRecord,
      writeRecord: (record) => {
        assertProgressStreamId(streamId);
        const persisted = readStoredRecord("arming recovery");
        if (persisted !== undefined && persisted.streamId !== streamId) {
          throw new StreamIdMismatchError(
            `stream processor "${args.name}" cannot arm recovery for stream ID ${streamId} ` +
              `over the record for ${persisted.streamId}`,
          );
        }
        args.storage.kv.put(recordKey, { ...record, streamId } satisfies StreamKeepaliveRecord);
      },
      armAlarm: (atMs) => args.armAlarm(atMs),
      keepAlive: (work) => args.waitUntil(work),
      // Append the journaled fact and stop — the wake delivery of that fact is
      // the recovery turn. Failures throw: the keepalive's breaker owns retries.
      revive: (record) => appendRevived(streamId, record),
      // A stream ID never becomes current again. Retrying its revival would
      // wake forever, so discard exactly this attempt. If a newer lifetime or
      // attempt already replaced the record, leave its alarm desire untouched.
      discardFailedRevival: (error, record) => {
        if (!isStreamIdMismatchError(error)) return false;
        const stored = readStoredRecord("discarding a stale revival");
        if (stored === undefined) {
          args.armAlarm(null);
        } else if (sameKeepaliveAttempt(stored, streamId, record)) {
          discardStoredRecord(`stream ID ${streamId} was replaced`);
        }
        return true;
      },
      // Best-effort journal evidence (crash-loop warnings). The stream-ID
      // guard prevents an old lifetime's evidence from landing in its replacement.
      appendFact: (event) => {
        void Promise.resolve()
          .then(() => {
            assertProgressStreamId(streamId);
            return args.stream.appendIfStreamId({ streamId, events: [event] });
          })
          .catch((error: unknown) => {
            console.error(
              `stream processor "${args.name}" keepalive evidence append failed`,
              error,
            );
          });
      },
      version: args.version,
    });
    activeKeepalive = { streamId, keepalive };
    return keepalive;
  };

  const recovery: ProcessorRecovery = {
    // The host's wiring verbatim (stream-processor-host.ts:445): every
    // registered closure — blocking, background, and the runner's whole-batch
    // attempt — rides the keepalive, so "the DO died owing work" is exactly
    // "the DO died with the alarm armed".
    keepAliveWhile: (work) => keepaliveFor(requireProgressStreamId()).track(work()),
    handleAlarm: async () => {
      // Delegation IS the whole handler: every alarm action drives the
      // injected seams from inside onAlarm before it returns — busy_rearmed
      // re-arms at the lead, clean_disarmed disarms via armAlarm(null), the
      // revival outcomes record + arm the backoff and run the revive hook (which
      // appends the revived fact). The keepalive self-gates on its persisted
      // armed time, so a fire belonging to another slice of the shared DO
      // alarm is a no-op here — route every fire to every runner.
      const record = readCurrentStoredRecord("handling an alarm");
      if (record === undefined) return;
      await keepaliveFor(record.streamId).onAlarm();
    },
    // The operator's no-deploy antidote for a 3-strikes plateau: clear the
    // crash-loop budget and pull the owed retry to the lead. Delegates
    // wholesale to the keepalive (the budget's one owner).
    resetBackoff: () => {
      const record = readCurrentStoredRecord("resetting the backoff");
      if (record === undefined) return;
      keepaliveFor(record.streamId).resetBackoff();
    },
  };

  // Boot-time reconcile (the host's post-construction block verbatim): a
  // fresh incarnation restores — and RE-ISSUES — the persisted alarm desire,
  // so a lost platform alarm heals when the host next opens instead of never.
  const persisted = readCurrentStoredRecord("booting");
  if (persisted !== undefined && persisted.armedAtMs !== null) {
    args.armAlarm(persisted.armedAtMs);
  }

  return recovery;
}
