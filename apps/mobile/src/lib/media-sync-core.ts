// The pure half of the screenshot sync engine (no Expo imports — vitest
// covers it): decides which library assets a sync pass processes and when
// to stop. There is deliberately NO persistent client cursor: the pass
// walks assets newest-first, asks the server per asset ("is this content
// hash already captured?"), and stops after enough consecutive knowns —
// the /media stream is the only source of truth, so a reinstall or second
// device is always safe. The cost (re-hashing the newest few assets each
// pass) is bounded by the stop rule and the per-pass cap.

/** Stop after this many consecutive already-captured assets: everything
 * older is assumed captured too. Newest-first ordering makes this sound
 * for the append-only screenshots roll. */
export const CONSECUTIVE_KNOWN_TO_STOP = 10;

/** New captures per pass — keeps a first sync of a 10k roll a polite,
 * repeatable bite instead of one giant blocking pass. */
export const MAX_NEW_PER_PASS = 50;

export type SyncPassDecision = "process" | "skip-known" | "stop";

/**
 * Feed assets newest-first; the tracker answers what to do with each and
 * flips to "stop" when the pass has seen enough. `markKnown`/`markNew` must
 * be called with each asset's server answer for the stop rule to work.
 */
export function createSyncPassTracker(limits: {
  consecutiveKnownToStop: number;
  maxNewPerPass: number;
}) {
  let consecutiveKnown = 0;
  let processed = 0;
  return {
    /** Whether the pass should continue at all. */
    shouldContinue(): boolean {
      return consecutiveKnown < limits.consecutiveKnownToStop && processed < limits.maxNewPerPass;
    },
    markKnown(): void {
      consecutiveKnown += 1;
    },
    markNew(): void {
      consecutiveKnown = 0;
      processed += 1;
    },
    summary(): { processed: number; stoppedOnKnownRun: boolean } {
      return {
        processed,
        stoppedOnKnownRun: consecutiveKnown >= limits.consecutiveKnownToStop,
      };
    },
  };
}
