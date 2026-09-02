// The environment-wide Durable Object circuit breaker ("ice switch").
//
// During a duration runaway (tasks/stream-do-wake-loop-runaway.md) the fleet's
// alarm loops — alarm → wake → woken-append → deliver → re-arm — keep tens of
// thousands of stream DOs billable around the clock, and the only historical
// containment was erase-data (destroys every DO; unusable on prd). This switch
// is the reversible alternative: while the flag is set, stream DOs consume
// alarms without re-arming, stop appending boot `woken` events, and refuse new
// alarm writes. Every hot loop dies at its next fire; data and cursors stay
// intact. Clearing the flag resumes normal behavior lazily — the next real
// interaction boots a stream, appends `woken`, and deliveries catch up from
// durable cursors exactly like post-eviction recovery.
//
// The flag lives in the environment's project-directory KV under a reserved
// key (never a valid project slug). That namespace is bound to every os
// worker and wiped by erase-data — the right reset semantics for a switch
// whose whole point is incident containment. Flip it with `pnpm cli ice`.
//
// Failure posture: the switch must never become its own outage. A missing
// binding, a KV read error, or a slow read all resolve to "not iced", and a
// read is raced against a short timeout so a KV incident cannot block DO
// boots behind blockConcurrencyWhile.

export const DO_ICE_KV_KEY = "reserved:do-ice";

/** Floor between KV re-reads in one incarnation. Long-lived residents pick up
 * a flip on their next alarm turn after this; hot (rebooting) DOs — the ones
 * that matter during a runaway — read fresh on every boot. */
const REFRESH_MS = 30_000;

/** A KV read must never hold up a DO boot (it sits inside the boot's
 * blockConcurrencyWhile); slower than this reads as un-iced and the next
 * refresh retries. */
const READ_TIMEOUT_MS = 500;

export class DoIceSwitch {
  readonly #kv: { get(key: string): Promise<string | null> } | undefined;
  #iced = false;
  #lastReadAtMs = 0;

  constructor(kv: { get(key: string): Promise<string | null> } | undefined) {
    this.#kv = kv;
  }

  get iced(): boolean {
    return this.#iced;
  }

  /** Refresh from KV, rate-limited; never throws and never hangs. */
  async refresh(): Promise<void> {
    if (this.#kv === undefined) return;
    const now = Date.now();
    if (now - this.#lastReadAtMs < REFRESH_MS) return;
    this.#lastReadAtMs = now;
    try {
      const value = await Promise.race([
        this.#kv.get(DO_ICE_KV_KEY),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
      ]);
      this.#iced = value !== null;
    } catch {
      this.#iced = false;
    }
  }
}
