// stream/background-claims.ts — the one claim ordering rule shared by processor hosts.

export class BackgroundClaims {
  readonly #claim: (at: number | null) => Promise<unknown>;
  readonly #report: (error: unknown) => void;
  readonly #afterMs: number;
  readonly #maxAfterMs: number;
  #inFlight = 0;
  #revivesWhileBusy = 0;
  #chain = Promise.resolve();

  constructor(options: {
    claim: (at: number | null) => Promise<unknown>;
    report: (error: unknown) => void;
    afterMs: number;
    maxAfterMs: number;
  }) {
    this.#claim = options.claim;
    this.#report = options.report;
    this.#afterMs = options.afterMs;
    this.#maxAfterMs = options.maxAfterMs;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  started(): void {
    this.#inFlight += 1;
    if (this.#inFlight === 1) this.at(Date.now() + this.#afterMs);
  }

  settled(): void {
    this.#inFlight -= 1;
    if (this.#inFlight !== 0) return;
    this.#revivesWhileBusy = 0;
    this.at(null);
  }

  /** Replace the host's one claim with this absolute deadline, behind every prior request. */
  at(at: number | null): void {
    this.#chain = this.#chain
      .then(async () => {
        await this.#claim(at);
      })
      .catch((error) => this.#report(error));
  }

  /** A due claim found work still alive: re-arm it with bounded exponential recovery. */
  async revivedWhileBusy(): Promise<void> {
    if (this.#inFlight === 0) return;
    this.#revivesWhileBusy += 1;
    this.at(Date.now() + Math.min(this.#afterMs * 2 ** this.#revivesWhileBusy, this.#maxAfterMs));
    await this.#chain;
  }
}
