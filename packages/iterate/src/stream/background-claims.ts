// stream/background-claims.ts — the one claim ordering rule shared by processor hosts.

export class BackgroundClaims<Captured = undefined> {
  readonly #claim: (at: number | null, captured: Captured | undefined) => Promise<unknown>;
  readonly #capture: (() => Captured) | undefined;
  readonly #report: (error: unknown) => void;
  readonly #afterMs: number;
  readonly #maxAfterMs: number;
  #inFlight = 0;
  #revivesWhileBusy = 0;
  #chain = Promise.resolve();

  constructor(options: {
    claim: (at: number | null, captured: Captured | undefined) => Promise<unknown>;
    /** Samples host state when a claim is requested, before another request can update it. */
    capture?: () => Captured;
    report: (error: unknown) => void;
    afterMs: number;
    maxAfterMs: number;
  }) {
    this.#claim = options.claim;
    this.#capture = options.capture;
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
    let captured: Captured | undefined;
    try {
      captured = this.#capture?.();
    } catch (error) {
      this.#report(error);
      return;
    }
    this.#chain = this.#chain
      .then(async () => {
        await this.#claim(at, captured);
      })
      .catch((error) => this.#report(error));
  }

  /** Wait until every claim requested so far has reached the host. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  /** A due claim found work still alive: re-arm it with bounded exponential recovery. */
  async revivedWhileBusy(): Promise<void> {
    if (this.#inFlight === 0) return;
    this.#revivesWhileBusy += 1;
    this.at(Date.now() + Math.min(this.#afterMs * 2 ** this.#revivesWhileBusy, this.#maxAfterMs));
    await this.#chain;
  }
}
