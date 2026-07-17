import {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
  type RetainedCallback,
} from "../rpc/retain.ts";
import { diff } from "./diff.ts";
import type { LiveUpdate } from "./protocol.ts";

/** Handle returned by `LiveState.subscribe` — the ownership + liveness surface for one subscriber. */
export type LiveStateSubscription = {
  /** Still registered on a live engine? A dead DO incarnation also makes the call reject. */
  ping(): boolean;
  unsubscribe(): void;
  [Symbol.dispose](): void;
};

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * A source-agnostic live store: hold a state value, and when it changes push the
 * minimal diff to every subscriber. It does not know or care where the state
 * comes from — a Durable Object folds events into it, a stateless RpcTarget polls
 * a third-party API into it — so ANY RpcTarget can expose live state by holding
 * one and returning a read-only wrapper from a `.live` getter.
 *
 * Two rules make it cheap and correct:
 * - Updates are IMMUTABLE (`setState`/`assign` build a new value, never mutate),
 *   so the diff short-circuits unchanged branches by identity — O(changed), not
 *   O(size). See `diff.ts`.
 * - Diffing and broadcasting happen only while a subscriber exists; a dormant
 *   engine just holds its value and schedules nothing.
 *
 * All subscribers ride ONE revision line: a new subscriber gets a full snapshot
 * at the current revision, and every flush pushes the same patch to everyone. A
 * subscriber that misses a patch (its `from` ≠ its revision) resyncs.
 */
export class LiveState<State extends object> {
  #current: State;
  /** The state every current subscriber has been brought to — the diff baseline. */
  #broadcast: State;
  #revision = 0;
  readonly #subscribers = new Set<RetainedCallback<LiveUpdate<State>>>();
  readonly #debounceMs: number;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(initial: State, options: { debounceMs?: number } = {}) {
    this.#current = initial;
    this.#broadcast = initial;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The current state — reflects every `setState`/`assign`, even while dormant. */
  getState(): State {
    return this.#current;
  }

  /** Replace the state. Build a NEW value (don't mutate) so the diff stays cheap. */
  setState(next: State | ((prev: State) => State)): void {
    this.#current = typeof next === "function" ? next(this.#current) : next;
    if (this.#subscribers.size > 0) this.#scheduleFlush();
  }

  /** Shallow-merge a partial into the state — sugar for `setState(p => ({ ...p, ...partial }))`. */
  assign(partial: Partial<State>): void {
    this.setState((prev) => ({ ...prev, ...partial }));
  }

  subscribe(sink: (update: LiveUpdate<State>) => unknown): LiveStateSubscription {
    // First subscriber after dormancy: adopt the latest state as the shared
    // baseline. While subscribers exist, `#broadcast` only advances inside a
    // flush (with a patch to everyone), so it always matches what they've seen.
    if (this.#subscribers.size === 0) this.#broadcast = this.#current;

    const retained = retainCallback(sink);
    this.#subscribers.add(retained);
    retained.onRpcBroken?.(() => this.#drop(retained));
    // The initial snapshot is the first paint — delivered now, never debounced.
    // A synchronously-throwing sink is dropped here and never becomes live.
    this.#deliver(retained, { type: "snapshot", revision: this.#revision, state: this.#broadcast });

    return {
      ping: () => this.#subscribers.has(retained),
      unsubscribe: () => this.#drop(retained),
      [Symbol.dispose]: () => this.#drop(retained),
    };
  }

  #scheduleFlush(): void {
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush();
    }, this.#debounceMs);
  }

  #flush(): void {
    const patch = diff(this.#broadcast, this.#current);
    if (patch === undefined) return;
    const from = this.#revision;
    const to = (this.#revision += 1);
    this.#broadcast = this.#current;
    const update: LiveUpdate<State> = { type: "patch", from, to, patch };
    for (const subscriber of [...this.#subscribers]) this.#deliver(subscriber, update);
  }

  /**
   * Fire-and-forget delivery that observes rejection. A dead stub rejects every
   * push (and can throw synchronously), so any failure drops the subscriber —
   * otherwise a corpse would keep its slot and its `ping()` would lie forever.
   */
  #deliver(subscriber: RetainedCallback<LiveUpdate<State>>, update: LiveUpdate<State>): void {
    let result: unknown;
    try {
      result = subscriber(update);
    } catch {
      this.#drop(subscriber);
      return;
    }
    if (isThenable(result)) {
      void Promise.resolve(result)
        .then(undefined, () => this.#drop(subscriber))
        .finally(() => disposeIgnoredRpcResult(result));
      return;
    }
    disposeIgnoredRpcResult(result);
  }

  #drop(subscriber: RetainedCallback<LiveUpdate<State>>): void {
    if (!this.#subscribers.delete(subscriber)) return;
    subscriber[Symbol.dispose]();
    if (this.#subscribers.size === 0 && this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer); // dormant again: no work until the next subscriber
      this.#flushTimer = undefined;
    }
  }
}
