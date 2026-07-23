/**
 * Workspace-scoped ephemeral presence: who is pointing WHERE on the board —
 * mouse pointers, not text carets (those live on the per-file collab
 * sessions in collab-host.ts; a follow-up can unify the two channels).
 *
 * In-memory only: an eviction loses the map and clients re-announce on
 * their next throttle tick. The payload is opaque to the server (the client
 * sends semantic anchors + fractional offsets so pointers land correctly
 * across different viewport layouts) but size-capped so one client cannot
 * bloat everyone's long-poll.
 */

const WAKE_COALESCE_MS = 100;
const STALE_MS = 45_000;
const WAIT_TIMEOUT_MS = 25_000;
const MAX_PAYLOAD_BYTES = 2_048;

export type PointerSnapshot = {
  clients: { at: number; clientId: string; payload: unknown }[];
  generation: number;
};

export class PointerPresence {
  readonly #clients = new Map<string, { at: number; payload: unknown }>();
  #generation = 0;
  readonly #waiters = new Set<() => void>();
  #wakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Announce (or clear, with null) one client's pointer. Quiet by design —
   * presence is decoration; oversized payloads are dropped, never an error. */
  present(clientId: string, payload: unknown): void {
    if (payload === null) this.#clients.delete(clientId);
    else {
      if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return;
      this.#clients.set(clientId, { at: Date.now(), payload });
    }
    this.#generation++;
    if (this.#wakeTimer === null) {
      this.#wakeTimer = setTimeout(() => {
        this.#wakeTimer = null;
        for (const wake of [...this.#waiters]) wake();
      }, WAKE_COALESCE_MS);
    }
  }

  /** Long-poll: resolves when the generation moves past `afterGeneration`
   * (coalesced), or with the unchanged snapshot after ~25s — the client
   * just re-waits, so a parked poll is the idle steady state. */
  async wait(afterGeneration: number): Promise<PointerSnapshot> {
    if (this.#generation <= afterGeneration) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, WAIT_TIMEOUT_MS);
        this.#waiters.add(wake);
      });
    }
    return this.snapshot();
  }

  snapshot(): PointerSnapshot {
    const now = Date.now();
    for (const [clientId, entry] of this.#clients) {
      if (now - entry.at > STALE_MS) this.#clients.delete(clientId);
    }
    return {
      clients: [...this.#clients]
        .map(([clientId, entry]) => ({ at: entry.at, clientId, payload: entry.payload }))
        .sort((left, right) => left.clientId.localeCompare(right.clientId)),
      generation: this.#generation,
    };
  }
}
