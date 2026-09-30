// kept.ts — ANSWERS AN ISOLATE KEEPS for a while, oldest first: the control plane's catalog rows
// (control-plane/edge.ts) and a webhook's signing key (context/built-ins.ts `webhooks`).

/** Answers kept `ttlMs` each: a key is deleted before it is set again, so a sweep from the front
 *  stops at the first answer still kept, and the table holds only what came in the last `ttlMs` —
 *  however many keys a scanner makes up. */
export class Kept<V> {
  readonly #answers = new Map<string, { at: number; value: V }>();
  readonly #ttlMs: number;
  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }
  /** The answer set under `key` within the last `ttlMs`, else undefined. */
  get(key: string) {
    const now = Date.now();
    for (const [oldest, { at }] of this.#answers) {
      if (now - at < this.#ttlMs) break;
      this.#answers.delete(oldest);
    }
    const kept = this.#answers.get(key);
    return kept && now - kept.at < this.#ttlMs ? kept.value : undefined;
  }
  set(key: string, value: V) {
    this.#answers.delete(key);
    this.#answers.set(key, { at: Date.now(), value });
  }
  delete(key: string) {
    this.#answers.delete(key);
  }
  clear() {
    this.#answers.clear();
  }
}
