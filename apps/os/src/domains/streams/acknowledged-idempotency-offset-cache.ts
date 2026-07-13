const MAX_ENTRIES = 128;
const MAX_KEY_CODE_UNITS = 512;

/**
 * Activation-local offsets for durable events committed through appendAck.
 * Misses always fall back to SQLite; only a complete batch hit bypasses it.
 */
export class AcknowledgedIdempotencyOffsetCache {
  readonly #offsets = new Map<string, number>();

  get(idempotencyKey: string): number | undefined {
    return this.#offsets.get(idempotencyKey);
  }

  getAll(idempotencyKeys: ReadonlySet<string>): Map<string, number> | undefined {
    const offsets = new Map<string, number>();
    for (const idempotencyKey of idempotencyKeys) {
      const offset = this.#offsets.get(idempotencyKey);
      if (offset === undefined) return undefined;
      offsets.set(idempotencyKey, offset);
    }
    return offsets;
  }

  remember(idempotencyKey: string, offset: number): void {
    if (idempotencyKey.length > MAX_KEY_CODE_UNITS || this.#offsets.has(idempotencyKey)) return;
    if (this.#offsets.size === MAX_ENTRIES) {
      const oldest = this.#offsets.keys().next().value;
      if (oldest !== undefined) this.#offsets.delete(oldest);
    }
    this.#offsets.set(idempotencyKey, offset);
  }
}
