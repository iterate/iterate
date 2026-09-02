// The Stream DO's crash-loop breaker: pure decisions over a small durable
// record, written BEFORE risky boot work — the crash that needs the record
// (an isolate OOM) is uncatchable and kills every in-memory counter, so the
// only bookkeeping that survives is what was synced ahead of the attempt.
//
// A crashed boot cannot be observed directly (no eviction hook, and an OOM
// leaves nothing behind), but a crash LOOP has an unmistakable signature in
// durable state: rapid successive boots with no clean signal in between. The
// bound-script-settlements incident (tasks/bound-script-settlements.md) wake-
// looped at ~5s cadence for hours — Cloudflare's alarm retry plus subscriber
// read retries re-boot the DO, the poisoned fold OOMs, repeat. Healthy
// streams never look like that: boots driven by real traffic are spaced out
// (spacing resets the count), and busy streams complete fold work (the clean
// signal resets the count). Only the conjunction — boots landing faster than
// RAPID_REBOOT_MS apart, threshold times in a row, with no clean signal —
// trips quarantine.

/** Boots closer together than this are treated as one crash-loop run. The
 * observed pathology re-boots every ~5s (platform alarm retry cadence);
 * legitimate wake-per-event streams that evict between events re-boot at
 * event spacing, comfortably above this. */
export const RAPID_REBOOT_MS = 30_000;

/** Rapid boots in a row, with no clean signal, before the stream parks.
 * 5 × ~5s ≈ trips within half a minute of a real loop; a deploy-restart or
 * one-off platform reset never strings 5 rapid boots together. */
export const BOOT_CRASH_QUARANTINE_THRESHOLD = 5;

/**
 * The durable record, stored in DO KV below the journal/fold (the same
 * placement as the keepalive's revival mark). `version` is the worker deploy
 * version: new code may fix the poison, so a deploy resets the count and
 * un-parks a quarantined stream on its next boot.
 */
export type BootCrashProbeRecord = {
  /** Rapid successive boots since the last clean signal (or spaced boot). */
  rapidBoots: number;
  /** Epoch ms of the most recent boot attempt (drives the spacing check). */
  lastBootAtMs: number;
  /** Worker deploy version at the last write. */
  version: string;
  /** Set when the threshold tripped; survives spaced-out boots (quarantine
   * means "stop retrying", and dropping the alarms slows the wakes — that
   * slowdown must not read as recovery). Cleared only by a version change or
   * clearProbe (the admin unpark). */
  quarantinedAtMs?: number;
};

type BootProbeDecision = {
  /** Persist with storage.sync() BEFORE arming alarms/folds/deliveries. */
  record: BootCrashProbeRecord;
  /**
   * "proceed": arm everything as normal.
   * "quarantine": do not arm alarms, facet replays, fold catch-up, or
   * delivery lanes; serve reads; reject appends loudly. Includes boots that
   * arrive already-quarantined (the record says so and nothing reset it).
   */
  action: "proceed" | "quarantine";
};

/**
 * The boot-time decision. Callers persist the returned record (sync) before
 * doing anything that could OOM. The count resets when any of these hold —
 * each means "this is not a crash loop continuing":
 *  - no prior record (first boot ever);
 *  - a different worker version (the deploy antidote, mirroring the
 *    keepalive's version-reset budget — also the unpark path, including for
 *    an already-quarantined record);
 *  - the previous boot was RAPID_REBOOT_MS or more ago (spaced wakes are
 *    real traffic, not a retry loop) — though an existing quarantine is NOT
 *    reset by spacing, see BootCrashProbeRecord.quarantinedAtMs.
 */
export function recordBootAttempt(input: {
  record: BootCrashProbeRecord | undefined;
  nowMs: number;
  version: string;
}): BootProbeDecision {
  const { record, nowMs, version } = input;
  if (record === undefined || record.version !== version) {
    return { action: "proceed", record: { rapidBoots: 1, lastBootAtMs: nowMs, version } };
  }
  if (record.quarantinedAtMs !== undefined) {
    // Parked this version: stay parked whatever the spacing, keep the
    // original trip time so operators can see when it happened.
    return { action: "quarantine", record: { ...record, lastBootAtMs: nowMs } };
  }
  if (nowMs - record.lastBootAtMs >= RAPID_REBOOT_MS) {
    return { action: "proceed", record: { rapidBoots: 1, lastBootAtMs: nowMs, version } };
  }
  const rapidBoots = record.rapidBoots + 1;
  if (rapidBoots >= BOOT_CRASH_QUARANTINE_THRESHOLD) {
    return {
      action: "quarantine",
      record: { rapidBoots, lastBootAtMs: nowMs, version, quarantinedAtMs: nowMs },
    };
  }
  return { action: "proceed", record: { rapidBoots, lastBootAtMs: nowMs, version } };
}

/**
 * Read-only quarantine check for surfaces that gate on parked state without
 * booting (append rejection, the UI banner, __describe). A record from an
 * older worker version never counts — the next boot's version reset will
 * unpark it.
 */
export function isQuarantined(input: {
  record: BootCrashProbeRecord | undefined;
  version: string;
}): boolean {
  return (
    input.record !== undefined &&
    input.record.version === input.version &&
    input.record.quarantinedAtMs !== undefined
  );
}

/**
 * The clean signal: a fold/alarm pass completed with nothing left owing, or
 * the incarnation survived its confirmation window. Persisting the cleared
 * record ends the current run — the next boot starts counting from 1 again.
 * Also the admin unpark ("unquarantine"): clearing IS the reset.
 */
export function clearProbe(input: { nowMs: number; version: string }): BootCrashProbeRecord {
  return { rapidBoots: 0, lastBootAtMs: input.nowMs, version: input.version };
}
